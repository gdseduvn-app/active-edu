FROM python:3.11-slim

WORKDIR /app

# Security: non-root user
RUN groupadd -r grader && useradd -r -g grader grader

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# Resource limits enforced by Docker Compose
USER grader

EXPOSE 8002

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002"]
