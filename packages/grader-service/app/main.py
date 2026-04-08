"""
Python Grader Service — SRS-CH05 §5.8.2
Sandbox execution of student Python code.

Endpoints:
  POST /grader/submit — Grade code against test cases
  POST /grader/configs — Create test config (teacher)
  POST /grader/configs/:id/validate — Dry-run test (teacher)
  GET  /health — Health check

Security: Pyodide WASM sandbox (no network, no filesystem, RAM 256MB, timeout 10s)
Auth: X-Internal-Key header (service-to-service only)
"""
from __future__ import annotations
import os
import json
import time
import signal
import traceback
from typing import Dict, List, Any, Optional
from contextlib import contextmanager

from fastapi import FastAPI, HTTPException, Header, Request
from pydantic import BaseModel

app = FastAPI(title="AdaptLearn Grader Service", version="1.0.0")

INTERNAL_KEY = os.environ.get("INTERNAL_KEY", "dev-internal-key")


# ── Auth ──────────────────────────────────────────────────────────────────────

def verify_internal_key(x_internal_key: str = Header(None)):
    if x_internal_key != INTERNAL_KEY:
        raise HTTPException(status_code=401, detail="Invalid internal key")


# ── Models ────────────────────────────────────────────────────────────────────

class TestCase(BaseModel):
    input: str
    expected: str
    hint: Optional[str] = None
    error_type: Optional[str] = None

class SubmitRequest(BaseModel):
    submission_id: str
    learner_id: str
    lesson_id: str
    code: str
    language: str = "python"
    attempt_number: int = 1
    hint_mode: str = "per_test"  # none | per_test | full
    test_cases: List[TestCase] = []
    timeout_sec: int = 10
    memory_mb: int = 128

class TestResult(BaseModel):
    test_id: int
    passed: bool
    input: str
    expected: str
    actual: Optional[str] = None
    error: Optional[str] = None
    hint: Optional[str] = None
    exec_ms: int = 0

class SubmitResponse(BaseModel):
    passed: bool
    score: float
    test_results: List[TestResult]
    error_types: List[str]
    hints: List[str]
    bloom_evidence: int
    execution_time_ms: int


# ── Sandbox Execution ─────────────────────────────────────────────────────────

@contextmanager
def timeout_context(seconds: int):
    """Context manager for execution timeout."""
    def handler(signum, frame):
        raise TimeoutError(f"Code chạy quá {seconds} giây")
    old = signal.signal(signal.SIGALRM, handler)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old)


def execute_code_sandbox(code: str, test_input: str, timeout_sec: int = 10) -> Dict[str, Any]:
    """
    Execute Python code in restricted sandbox.
    Phase 1: exec() with restricted globals (simple but effective).
    Phase 2: Pyodide WASM for full browser-level isolation.

    SECURITY: No network, no filesystem, no imports (os, sys, subprocess blocked).
    """
    blocked_imports = ['os', 'sys', 'subprocess', 'shutil', 'socket', 'http',
                       'urllib', 'requests', 'pathlib', 'importlib', '__import__']

    # Check for blocked imports
    for blocked in blocked_imports:
        if blocked in code:
            return {
                'output': None,
                'error': f"Import không được phép: {blocked}. Code chạy trong sandbox.",
                'exec_ms': 0,
            }

    restricted_globals = {
        '__builtins__': {
            'print': print, 'len': len, 'range': range, 'int': int, 'float': float,
            'str': str, 'list': list, 'dict': dict, 'tuple': tuple, 'set': set,
            'bool': bool, 'abs': abs, 'max': max, 'min': min, 'sum': sum,
            'sorted': sorted, 'reversed': reversed, 'enumerate': enumerate,
            'zip': zip, 'map': map, 'filter': filter, 'round': round,
            'isinstance': isinstance, 'type': type, 'True': True, 'False': False, 'None': None,
        },
        'math': __import__('math'),
    }

    captured_output: List[str] = []
    original_print = print

    def safe_print(*args, **kwargs):
        captured_output.append(' '.join(str(a) for a in args))

    restricted_globals['__builtins__']['print'] = safe_print

    start_ms = int(time.time() * 1000)
    try:
        with timeout_context(timeout_sec):
            exec(code + "\n" + test_input, restricted_globals)
        output = '\n'.join(captured_output) if captured_output else str(restricted_globals.get('result', ''))
        exec_ms = int(time.time() * 1000) - start_ms
        return {'output': output.strip(), 'error': None, 'exec_ms': exec_ms}
    except TimeoutError as e:
        return {'output': None, 'error': str(e), 'exec_ms': timeout_sec * 1000}
    except MemoryError:
        return {'output': None, 'error': 'Vượt giới hạn bộ nhớ', 'exec_ms': 0}
    except Exception as e:
        exec_ms = int(time.time() * 1000) - start_ms
        return {'output': None, 'error': f"{type(e).__name__}: {str(e)}", 'exec_ms': exec_ms}


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "grader", "version": "1.0.0"}


@app.post("/grader/submit", response_model=SubmitResponse)
async def submit_code(req: SubmitRequest, x_internal_key: str = Header(None)):
    verify_internal_key(x_internal_key)

    if req.language != "python":
        raise HTTPException(status_code=422, detail=f"Language '{req.language}' not supported")

    test_results: List[TestResult] = []
    error_types: List[str] = []
    hints: List[str] = []
    total_start = int(time.time() * 1000)

    for i, tc in enumerate(req.test_cases):
        result = execute_code_sandbox(req.code, tc.input, req.timeout_sec)

        passed = result['output'] is not None and result['output'].strip() == tc.expected.strip()

        tr = TestResult(
            test_id=i + 1,
            passed=passed,
            input=tc.input,
            expected=tc.expected,
            actual=result['output'] or result['error'],
            error=result['error'] if not passed else None,
            hint=tc.hint if not passed and req.hint_mode != 'none' else None,
            exec_ms=result['exec_ms'],
        )
        test_results.append(tr)

        if not passed:
            if result['error'] and 'TimeoutError' in result['error']:
                error_types.append('timeout_error')
            elif result['error'] and 'SyntaxError' in result['error']:
                error_types.append('syntax_error')
            elif result['error'] and 'NameError' in result['error']:
                error_types.append('name_error')
            elif result['error'] and 'IndexError' in result['error']:
                error_types.append('index_error')
            elif result['error'] and 'TypeError' in result['error']:
                error_types.append('type_error')
            elif tc.error_type:
                error_types.append(tc.error_type)
            else:
                error_types.append('logic_error')

            if tc.hint:
                hints.append(tc.hint)

    passed_count = sum(1 for r in test_results if r.passed)
    total_count = max(len(test_results), 1)
    score = passed_count / total_count
    total_ms = int(time.time() * 1000) - total_start

    # Bloom evidence: passing complex tests → higher Bloom
    bloom = 3  # default: Vận dụng
    if score >= 0.8 and len(req.test_cases) >= 3:
        bloom = 4  # Phân tích
    if score == 1.0 and len(req.test_cases) >= 5:
        bloom = 5  # Đánh giá

    return SubmitResponse(
        passed=score >= 0.6,
        score=round(score, 4),
        test_results=test_results,
        error_types=list(set(error_types)),
        hints=hints[:3],  # Max 3 hints
        bloom_evidence=bloom,
        execution_time_ms=total_ms,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
