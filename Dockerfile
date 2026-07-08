# Use an official Python runtime as a parent image
FROM python:3.10-slim

# Set the working directory in the container
WORKDIR /app

# Copy the requirements file into the container
COPY requirements.txt .

# Install any needed packages specified in requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Force a cache bust so Hugging Face downloads the newly fixed model
ENV CACHE_BUST=2026-07-08

# Prevent TensorFlow from getting stuck in an infinite loop on older CPUs
ENV TF_ENABLE_ONEDNN_OPTS=0

# Force logs to stream instantly so Hugging Face doesn't hide errors
ENV PYTHONUNBUFFERED=1

# Copy the application code and the model directly (since they were uploaded to root)
COPY app.py .
COPY toxic_comment_model.keras .

# Expose port 7860 (Hugging Face Spaces default port)
EXPOSE 7860

# Run the application
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
