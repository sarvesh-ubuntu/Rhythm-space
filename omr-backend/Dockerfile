# Use official Python runtime as a parent image
FROM python:3.10-slim

# Install system dependencies (including poppler-utils for pdf2image and glix for opencv)
RUN apt-get update && apt-get install -y \
    poppler-utils \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /code

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY . .

# Create a non-root user (Hugging Face Spaces requirement for Docker)
RUN useradd -m -u 1000 user
# Give permission to the user for the code directory so it can create temp files
RUN chown -R user:user /code
USER user

ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

# Expose port 7860 which is used by Hugging Face Spaces
EXPOSE 7860

# Command to run the FastAPI server
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
