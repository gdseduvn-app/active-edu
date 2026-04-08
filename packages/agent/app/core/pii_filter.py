"""
PII Filter — NĐ 13/2023 Compliance (FR-41-05)

Strips personally identifiable information before sending to external APIs (Claude).
NEVER send: learner name, email, phone, class_id
ONLY send: anonymized learner_id hash, academic content, error patterns
"""

import hashlib
import re
from typing import Any, Dict, List, Tuple


# PII patterns to detect and strip
PII_PATTERNS = [
    (r'[\w\.-]+@[\w\.-]+\.\w+', '[EMAIL_REMOVED]'),  # emails
    (r'\b0\d{9,10}\b', '[PHONE_REMOVED]'),  # Vietnamese phone numbers
    (r'\b\d{9,12}\b', '[ID_REMOVED]'),  # ID numbers
]

# Fields that should NEVER be sent to external APIs
BLOCKED_FIELDS = {
    'full_name', 'email', 'phone', 'address', 'class_id',
    'username', 'avatar_url', 'password_hash', 'ip_address',
    'parent_email', 'parent_name',
}


def anonymize_learner_id(learner_id: str, salt: str = 'adaptlearn_2025') -> str:
    """Create a short anonymous hash of learner_id for external API calls."""
    return hashlib.sha256(f'{salt}:{learner_id}'.encode()).hexdigest()[:16]


def strip_pii_from_text(text: str) -> str:
    """Remove PII patterns (emails, phones, IDs) from text content."""
    if not text:
        return text
    result = text
    for pattern, replacement in PII_PATTERNS:
        result = re.sub(pattern, replacement, result)
    return result


def sanitize_for_external_api(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Sanitize a dictionary before sending to external APIs (Claude, Mathpix, etc.)
    - Removes blocked fields
    - Anonymizes learner_id
    - Strips PII from text values
    """
    sanitized = {}
    for key, value in data.items():
        # Skip blocked fields entirely
        if key in BLOCKED_FIELDS:
            continue

        # Anonymize learner_id
        if key == 'learner_id' and isinstance(value, str):
            sanitized['anon_id'] = anonymize_learner_id(value)
            continue

        # Recurse into dicts
        if isinstance(value, dict):
            sanitized[key] = sanitize_for_external_api(value)
        # Strip PII from strings
        elif isinstance(value, str):
            sanitized[key] = strip_pii_from_text(value)
        # Pass through other types
        else:
            sanitized[key] = value

    return sanitized


def prepare_socratic_context(
    question_text: str,
    student_answer: str,
    error_type: str,
    learner_context: dict,
) -> dict:
    """
    Prepare context for Socratic Engine Claude API call.
    Ensures NO PII leaks per FR-41-05.
    """
    return {
        'question': strip_pii_from_text(question_text),
        'student_answer': strip_pii_from_text(student_answer),
        'error_type': error_type,
        'current_level': learner_context.get('current_level', 'nen_tang'),
        'bloom_profile': learner_context.get('bloom_profile', {}),
        # DO NOT include: name, email, class, any identifying info
    }


def validate_no_pii(payload: dict) -> List[str]:
    """
    Validate that a payload contains no PII before sending externally.
    Returns list of violations (empty = clean).
    """
    violations = []

    def check_dict(d: dict, path: str = ''):
        for key, value in d.items():
            current_path = f'{path}.{key}' if path else key
            if key in BLOCKED_FIELDS:
                violations.append(f'Blocked field found: {current_path}')
            if isinstance(value, str):
                for pattern, _ in PII_PATTERNS:
                    if re.search(pattern, value):
                        violations.append(f'PII pattern in {current_path}: {pattern}')
            elif isinstance(value, dict):
                check_dict(value, current_path)

    check_dict(payload)
    return violations
