"""
AURA Pipeline — Active-learning Unit Repository & Adapter
Source: SRS-CH07 v3.0 §7.2–7.4

4 Goals per learning material:
  EMBED  — serve interactively to student
  PARSE  — extract structured metadata
  STORE  — store raw file with versioning
  SYNC   — sync metadata to Agent
"""
from __future__ import annotations
from enum import Enum
from dataclasses import dataclass
from typing import Any
import re


class MaterialType(str, Enum):
    HTML         = 'html'
    PDF          = 'pdf'
    VIDEO        = 'video'
    QUIZ_JSON    = 'quiz_json'
    PYTHON_SCRIPT = 'python_script'
    IMAGE        = 'image'
    AUDIO        = 'audio'


class PipelineGoal(str, Enum):
    EMBED = 'EMBED'   # serve interactively in iframe/viewer
    PARSE = 'PARSE'   # extract metadata → DB
    STORE = 'STORE'   # MinIO with versioning
    SYNC  = 'SYNC'    # agent_metadata for Curriculum Planner


@dataclass
class AURAPipelineResult:
    material_id: str
    material_type: MaterialType
    goals_completed: list[PipelineGoal]
    embed_url: str | None
    parsed_content: dict[str, Any]
    agent_metadata: dict[str, Any]
    errors: list[str]
    success: bool


# ─── EMBED configs per material type (SRS §7.2.1) ──────────────────────
EMBED_CONFIG = {
    MaterialType.HTML: {
        'mechanism': 'iframe',
        'sandbox': 'allow-scripts allow-same-origin',
        # NEVER add: allow-forms, allow-popups, allow-top-navigation
        'csp': "default-src 'self'; script-src 'self'",
        'inject_aura_sdk': True,   # inject tracker before </body>
        'fr': ['FR-721-01', 'FR-721-02'],
    },
    MaterialType.PDF: {
        'mechanism': 'pdfjs_viewer',
        'toolbar_hidden': True,    # no print/download button
        'track_pages': True,       # event per page turn
        'fr': ['FR-721-03', 'FR-721-04'],
    },
    MaterialType.VIDEO: {
        'mechanism': 'hls_videojs',
        'adaptive_bitrate': True,
        'track_pause': True,       # event on pause with timestamp
        'track_chapters': True,
        'enforce_order': False,    # configurable per lesson
        'fr': ['FR-721-05', 'FR-721-06'],
    },
    MaterialType.PYTHON_SCRIPT: {
        'mechanism': 'pyodide_wasm',  # WebAssembly sandbox
        'timeout_seconds': 10,
        'capture_stdout': True,
        'no_network': True,
        'no_filesystem': True,
        'fr': ['FR-721-07', 'FR-721-08'],
    },
    MaterialType.QUIZ_JSON: {
        'mechanism': 'quiz_engine',
        'no_scripts': True,
        'fr': ['FR-721-09'],
    },
}


# ─── PARSE functions ─────────────────────────────────────────────────────

def parse_html_aura(html_content: str) -> dict[str, Any]:
    """
    Parse AURA HTML schema into structured metadata.
    Extracts: lesson_id, bloom_level, solo_target, al_format,
              questions, rubrics, ILOs, stage structure.
    """
    metadata: dict[str, Any] = {}

    # Extract article data attributes
    attrs = re.findall(r'data-([\w-]+)="([^"]*)"', html_content)
    for key, val in attrs:
        camel = ''.join(w.capitalize() if i else w for i, w in enumerate(key.split('-')))
        try:
            metadata[camel] = int(val)
        except ValueError:
            metadata[camel] = val

    # Extract questions
    questions = []
    q_blocks = re.findall(r'<div[^>]*class="aura-q"[^>]*>(.*?)</div>', html_content, re.DOTALL)
    for block in q_blocks:
        q: dict[str, Any] = {}
        for attr in re.findall(r'data-([\w-]+)="([^"]*)"', block):
            q[attr[0].replace('-', '_')] = attr[1]
        # Extract question text
        p_match = re.search(r'<p[^>]*>(.*?)</p>', block, re.DOTALL)
        if p_match:
            q['stem'] = re.sub(r'<[^>]+>', '', p_match.group(1)).strip()
        questions.append(q)

    metadata['questions'] = questions
    metadata['question_count'] = len(questions)
    metadata['total_points'] = sum(
        float(q.get('points', 0)) for q in questions)

    # Extract ILOs
    ilo_meta = metadata.get('auraIlos', '[]')
    try:
        import json
        metadata['ilos'] = json.loads(ilo_meta) if isinstance(ilo_meta, str) else ilo_meta
    except Exception:
        metadata['ilos'] = []

    return metadata


def parse_quiz_json(data: dict[str, Any]) -> dict[str, Any]:
    """
    Validate and parse Quiz JSON against AURA schema.
    """
    required = ['questions', 'lesson_code', 'bloom_level']
    missing = [k for k in required if k not in data]
    if missing:
        return {'error': f'Missing required fields: {missing}'}

    return {
        'lesson_code': data.get('lesson_code'),
        'bloom_level': data.get('bloom_level'),
        'question_count': len(data.get('questions', [])),
        'question_types': list({q.get('type') for q in data.get('questions', [])}),
        'total_points': sum(q.get('points', 1) for q in data.get('questions', [])),
        'has_rubric': any(q.get('rubric') for q in data.get('questions', [])),
        'valid': True,
    }


# ─── SYNC: Agent metadata generation ────────────────────────────────────

def build_agent_metadata(
    parsed: dict[str, Any],
    material_type: MaterialType,
) -> dict[str, Any]:
    """
    Build agent_metadata from parsed content.
    Agent uses this for Curriculum Planner decisions.
    """
    return {
        'learning_objectives': parsed.get('ilos', []),
        'bloom_level': parsed.get('bloomLevel') or parsed.get('bloom_level'),
        'solo_target': parsed.get('soloTarget') or parsed.get('solo_target'),
        'al_format': parsed.get('alFormat') or parsed.get('al_format'),
        'knowledge_type': parsed.get('knowledgeType', 'declarative'),
        'threshold_concept': parsed.get('threshold', '0') != '0',
        'question_count': parsed.get('question_count', 0),
        'total_points': parsed.get('total_points', 0),
        'has_ai_graded': any(
            q.get('type') == 'open_ai' for q in parsed.get('questions', [])),
        'estimated_minutes': int(parsed.get('estimatedMinutes', 20)),
        'material_type': material_type.value,
        'sync_version': 1,
    }
