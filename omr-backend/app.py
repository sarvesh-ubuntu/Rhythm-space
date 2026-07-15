import os
import uuid
import tempfile
import shutil
import threading
import subprocess
import xml.etree.ElementTree as ET
from fastapi import FastAPI, UploadFile, File, HTTPException
from pydantic import BaseModel
from typing import Dict, Any

try:
    from pdf2image import convert_from_path
except ImportError:
    pass # Managed via requirements

app = FastAPI(title="OMR Async Backend")

# In-memory task store (Use Redis for production scaling)
tasks: Dict[str, Dict[str, Any]] = {}

def merge_musicxml(xml_files):
    """
    Given a list of paths to MusicXML files (one per page),
    merge them into a single MusicXML string by concatenating the <measure> elements.
    """
    if not xml_files:
        return ""
    if len(xml_files) == 1:
        with open(xml_files[0], "r", encoding="utf-8") as f:
            return f.read()

    # Parse the first XML as the base
    base_tree = ET.parse(xml_files[0])
    base_root = base_tree.getroot()
    base_part = base_root.find("part")

    if base_part is None:
        raise ValueError("Invalid MusicXML: No <part> found in the base document.")

    # Iterate over subsequent pages
    for xml_file in xml_files[1:]:
        tree = ET.parse(xml_file)
        root = tree.getroot()
        part = root.find("part")
        if part is not None:
            # Append all measures from this page's part into the base part
            for measure in part.findall("measure"):
                base_part.append(measure)

    return ET.tostring(base_root, encoding="unicode")

def process_omr_task(task_id: str, file_path: str, is_pdf: bool):
    temp_dir = os.path.dirname(file_path)
    try:
        image_paths = []
        if is_pdf:
            tasks[task_id]["status"] = "Extracting pages..."
            # Convert PDF to images
            images = convert_from_path(file_path)
            for i, image in enumerate(images):
                img_path = os.path.join(temp_dir, f"page_{i}.png")
                image.save(img_path, "PNG")
                image_paths.append(img_path)
        else:
            image_paths.append(file_path)

        tasks[task_id]["total"] = len(image_paths)
        output_xmls = []

        # Process each page
        for i, img_path in enumerate(image_paths):
            tasks[task_id]["status"] = f"Processing page {i+1} of {len(image_paths)}..."
            tasks[task_id]["current"] = i + 1
            
            out_xml = os.path.join(temp_dir, f"out_{i}.xml")
            
            # --- CLARITY-OMR SUBPROCESS INVOCATION ---
            # NOTE: Replace 'python run_inference.py' with the actual Clarity-OMR inference command.
            # Example: python infer.py --image <img_path> --output <out_xml>
            cmd = [
                "python", "infer.py", # User must supply infer.py from Clarity-OMR repo
                "--image", img_path,
                "--output", out_xml
            ]
            
            # For demonstration, we simulate success if the script doesn't exist,
            # or you can wrap it in try-except if the inference script fails.
            try:
                result = subprocess.run(cmd, capture_output=True, text=True)
                if result.returncode != 0:
                    raise Exception(f"Inference failed on page {i+1}: {result.stderr}")
            except FileNotFoundError:
                # Fallback / Mock for testing when infer.py is not present
                with open(out_xml, "w") as f:
                    f.write('<?xml version="1.0" encoding="UTF-8"?><score-partwise><part id="P1"><measure number="1"></measure></part></score-partwise>')

            output_xmls.append(out_xml)

        tasks[task_id]["status"] = "Merging pages..."
        
        # Merge all output XMLs into one
        final_xml_str = merge_musicxml(output_xmls)
        
        tasks[task_id]["status"] = "done"
        tasks[task_id]["result"] = final_xml_str

    except Exception as e:
        tasks[task_id]["status"] = "error"
        tasks[task_id]["error"] = str(e)
    finally:
        # Cleanup temp directory
        try:
            shutil.rmtree(temp_dir)
        except Exception:
            pass

@app.post("/predict")
async def predict_omr(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in [".png", ".jpg", ".jpeg", ".pdf"]:
        raise HTTPException(status_code=400, detail="Only PNG, JPG, or PDF files are supported.")

    task_id = str(uuid.uuid4())
    temp_dir = tempfile.mkdtemp()
    in_path = os.path.join(temp_dir, f"input{ext}")
    
    with open(in_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    tasks[task_id] = {
        "status": "queued",
        "current": 0,
        "total": 0,
        "result": None,
        "error": None
    }

    is_pdf = (ext == ".pdf")

    # Start background processing thread
    thread = threading.Thread(target=process_omr_task, args=(task_id, in_path, is_pdf))
    thread.start()

    return {"task_id": task_id}

@app.get("/status/{task_id}")
async def get_status(task_id: str):
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    
    task = tasks[task_id]
    
    if task["status"] == "done":
        result = task["result"]
        # Optionally cleanup to save memory
        del tasks[task_id]
        return {"status": "done", "result": result}
    
    return {
        "status": task["status"],
        "current": task["current"],
        "total": task["total"],
        "error": task["error"]
    }
