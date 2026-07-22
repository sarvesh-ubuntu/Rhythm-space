"""
Rhythm Space — OMR backend (local Docker, Audiveris engine)

Why this replaces the HF Spaces / ZeroGPU / oemer version:
  - Audiveris is CPU-only, established (20+ years), fast (seconds per
    page for typeset scores), and outputs MusicXML natively. No GPU,
    no per-call duration budgeting, no daily quota, no checkpoint
    download on first run — none of the ZeroGPU-specific machinery in
    the previous version of this file is needed anymore.
  - Audiveris is a separate Java process. We shell out to it via
    subprocess, the same architectural shape as the old oemer calls,
    just pointed at a different binary with a different output format
    (.mxl — a zipped MusicXML container — instead of a raw .musicxml
    file), which is why _run_inference_one_page below unzips its output
    before returning.
  - Printed/typeset scores only — Audiveris does not support handwritten
    notation. If that's ever a requirement, this engine choice needs
    revisiting.

Run locally:
    docker compose up --build
Then open http://localhost:7860
"""

import os
import shutil
import subprocess
import tempfile
import zipfile
import xml.etree.ElementTree as ET

import gradio as gr

try:
    from pdf2image import convert_from_path
except ImportError:
    convert_from_path = None


# Resolved once at container build time (see Dockerfile) and written to
# /etc/environment inside the image. Falling back to a PATH lookup keeps
# this working if you ever run app.py outside that exact Docker image
# (e.g. a host install of Audiveris during local development).
AUDIVERIS_BIN = os.environ.get("AUDIVERIS_BIN") or shutil.which("Audiveris") or "Audiveris"


def _extract_musicxml_from_mxl(mxl_path: str, out_xml: str) -> None:
    """Audiveris exports .mxl — a zip container holding the actual
    MusicXML plus a META-INF/container.xml manifest, same shape as a
    .docx or .pptx. Pull the real score out and write it as raw XML to
    out_xml so the rest of the pipeline (merge_musicxml, the download
    button) doesn't need to know .mxl exists at all."""
    with zipfile.ZipFile(mxl_path) as zf:
        candidates = [
            name for name in zf.namelist()
            if name.lower().endswith(".xml") and not name.startswith("META-INF/")
        ]
        if not candidates:
            raise RuntimeError(
                f"'{mxl_path}' doesn't look like a valid .mxl file — "
                "no MusicXML entry found inside it."
            )
        # If Audiveris ever emits more than one (e.g. multi-movement
        # detection), take the largest — almost always the real score,
        # not a small manifest/fragment.
        chosen = max(candidates, key=lambda n: zf.getinfo(n).file_size)
        with zf.open(chosen) as src, open(out_xml, "wb") as dst:
            shutil.copyfileobj(src, dst)


def _run_inference(img_path: str, out_xml: str) -> None:
    """Run Audiveris OMR on a score file, writing MusicXML to out_xml."""
    import glob

    scratch_dir = os.path.join(os.path.dirname(out_xml), "_audiveris_out")
    os.makedirs(scratch_dir, exist_ok=True)

    # -batch     : no GUI — required for headless Docker use.
    # -transcribe: run the full recognition pipeline (LOAD → … → PAGE).
    # -force     : re-process even if a cached .omr from a previous
    #              run is present in the scratch dir.
    # -export    : after transcription, write MusicXML (.mxl container).
    # -output    : folder where Audiveris writes its scratch tree + output.
    # --         : separates Audiveris flags from the input path.
    cmd = [
        AUDIVERIS_BIN,
        "-batch",
        "-transcribe",
        "-force",
        "-export",
        "-output", scratch_dir,
        "--", img_path,
    ]
    try:
        # Full pipeline on a dense multi-instrument book can legitimately
        # take several minutes; 900s is generous headroom.
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"Couldn't find/run the Audiveris binary at '{AUDIVERIS_BIN}'. "
            "This should be baked into the Docker image — check the "
            "Dockerfile's build stage if you're seeing this."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"OMR timed out on this file (>900s): {exc}") from exc

    if result.returncode != 0:
        raise RuntimeError(f"Audiveris failed: {(result.stderr or result.stdout)[-2000:]}")

    # Audiveris may emit .mxl (zip container) or plain .xml depending on
    # version and step configuration — check both.
    candidates = sorted(
        glob.glob(os.path.join(scratch_dir, "**", "*.mxl"), recursive=True)
        + glob.glob(os.path.join(scratch_dir, "**", "*.xml"), recursive=True)
    )
    if not candidates:
        raise RuntimeError(
            "Audiveris exited successfully but produced no .mxl/.xml output "
            f"in {scratch_dir}. stdout: {result.stdout[-500:]}"
        )
    chosen = max(candidates, key=os.path.getmtime)
    if chosen.lower().endswith(".mxl"):
        _extract_musicxml_from_mxl(chosen, out_xml)
    else:
        # Plain .xml — copy directly; no unzipping needed.
        shutil.copyfile(chosen, out_xml)


def run_omr(file_obj, progress=gr.Progress()):
    """Entry point wired to the Gradio Blocks button below. No GPU
    decorator, no queueing tricks needed — Audiveris runs happily as a
    plain synchronous subprocess call on ordinary CPU."""
    if file_obj is None:
        raise gr.Error("No file provided.")

    src_path = file_obj if isinstance(file_obj, str) else file_obj.name
    ext = os.path.splitext(src_path)[1].lower()
    if ext not in (".png", ".jpg", ".jpeg", ".pdf"):
        raise gr.Error("Only PNG, JPG, or PDF files are supported.")

    # Audiveris natively uses the input filename as the <work-title>.
    # Keep the original basename so the output XML has the correct title.
    import re
    base_name = os.path.splitext(os.path.basename(src_path))[0]
    base_name = re.sub(r'[^\w\s-]', '', base_name).strip() or "score"

    temp_dir = tempfile.mkdtemp(prefix="rym-omr-")
    try:
        if ext == ".pdf":
            if convert_from_path is None:
                raise gr.Error(
                    "PDF support isn't available (pdf2image/poppler missing "
                    "— check the Dockerfile installs poppler-utils)."
                )
            progress(0.0, desc="Extracting PDF pages…")
            images = convert_from_path(src_path)
            if not images:
                raise gr.Error("Could not extract any pages from this PDF.")
            
            # Combine pages into a multi-page TIFF so Audiveris treats
            # it as a single book, preserving cross-page slurs.
            target_path = os.path.join(temp_dir, f"{base_name}.tiff")
            if len(images) == 1:
                images[0].save(target_path, format="TIFF")
            else:
                images[0].save(target_path, format="TIFF", save_all=True, append_images=images[1:])
        else:
            target_path = os.path.join(temp_dir, f"{base_name}{ext}")
            shutil.copyfile(src_path, target_path)

        progress(0.5, desc="Running Audiveris (this may take a few minutes)…")
        out_xml = os.path.join(temp_dir, f"{base_name}_out.xml")
        
        try:
            _run_inference(target_path, out_xml)
        except Exception as exc:
            raise gr.Error(f"OMR failed: {exc}")

        with open(out_xml, "r", encoding="utf-8") as f:
            xml_str = f.read()

        download_fd, download_path = tempfile.mkstemp(
            prefix=f"{base_name}-", suffix=".musicxml"
        )
        with os.fdopen(download_fd, "w", encoding="utf-8") as f:
            f.write(xml_str)

        progress(1.0, desc="Done")
        return xml_str, download_path

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


with gr.Blocks(title="Rhythm Space — OMR") as demo:
    gr.Markdown(
        "# Rhythm Space — OMR\n"
        "Upload a scanned score (PNG/JPG/PDF). Runs locally via Audiveris "
        "— typeset/printed scores only, no handwritten notation."
    )
    inp = gr.File(
        label="Sheet music (PNG/JPG/PDF)",
        file_types=[".png", ".jpg", ".jpeg", ".pdf"],
    )
    btn = gr.Button("Run OMR", variant="primary")
    out = gr.Textbox(label="MusicXML output", lines=20, show_copy_button=True)
    out_file = gr.File(label="Download .musicxml")

    btn.click(fn=run_omr, inputs=inp, outputs=[out, out_file], api_name="run_omr")

# No .queue() needed for GPU-call reasons anymore, but harmless/still
# useful to keep multiple browser tabs from stepping on each other.
# server_name="0.0.0.0" is required for the app to be reachable from
# outside the container (Docker's default bridge network otherwise only
# exposes 127.0.0.1 inside the container itself).
demo.queue(max_size=32, default_concurrency_limit=4).launch(
    server_name="0.0.0.0", server_port=7860
)
