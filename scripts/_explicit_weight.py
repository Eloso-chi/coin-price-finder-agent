"""Explicit precious-metal weight validation shared by scraper entry points."""

import re

WORD_WEIGHTS = {"half": 0.5, "quarter": 0.25, "tenth": 0.1, "twentieth": 0.05}
MAX_WEIGHT_OUNCES = 1000
MAX_SEARCH_TERM_LENGTH = 500
OUNCE_UNIT_PATTERN = re.compile(r"(?:ounces?|ozt|ozs?)\b", re.IGNORECASE)
VALID_NUMERIC_LITERAL = re.compile(r"^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$")
NUMERIC_LOOKING_LITERAL = re.compile(r"^[+-]?(?:\d|\.\d|infinity\b|nan\b)", re.IGNORECASE)
def _parse_numeric_weight(literal):
    if not VALID_NUMERIC_LITERAL.fullmatch(literal):
        return None
    decimal_places = len(literal) - literal.index(".") - 1 if "." in literal else 0
    try:
        ounces = float(literal)
    except ValueError:
        return None
    if not (0 < ounces <= MAX_WEIGHT_OUNCES) or decimal_places > 6:
        return None
    return ounces


def _parse_fraction_weight(literal):
    match = re.fullmatch(r"(?:(\d+)\s+)?(\d+)\s*/\s*(\d+)", literal)
    if not match:
        return None
    whole_text, numerator_text, denominator_text = match.groups()
    numerator = int(numerator_text)
    denominator = int(denominator_text)
    if denominator == 0:
        return None
    ounces = float(whole_text or 0) + numerator / denominator
    if not (0 < ounces <= MAX_WEIGHT_OUNCES):
        return None
    return round(ounces, 6) if round(ounces, 6) == ounces else None


def _numeric_expression_before_unit(text, unit_index):
    prefix = text[max(0, unit_index - 64):unit_index].rstrip()
    if re.search(r"\btroy$", prefix, re.IGNORECASE):
        prefix = re.sub(r"\btroy$", "", prefix, flags=re.IGNORECASE).rstrip()
    mixed_fraction = re.search(r"((?<!\d)(?:\d+\s+)?\d+\s*/\s*\d+)$", prefix)
    if mixed_fraction:
        literal = re.sub(r"\s+", " ", mixed_fraction.group(1))
        year_and_fraction = re.fullmatch(r"((?:17|18|19|20)\d{2})\s+((?:\d+\s+)?\d+\s*/\s*\d+)", literal)
        return re.sub(r"\s+", " ", year_and_fraction.group(2)) if year_and_fraction else literal

    fraction = re.search(r"([+-]?\d+\s*/\s*\d+)$", prefix)
    if fraction:
        return re.sub(r"\s", "", fraction.group(1))
    grouped = re.search(r"([+-]?\d+(?:\s+['’]?\s*\d{3})+)$", prefix)
    if grouped:
        return grouped.group(1)
    token = re.search(r"([^\s([{]+)$", prefix)
    return token.group(1) if token and NUMERIC_LOOKING_LITERAL.match(token.group(1)) else None


def _has_invalid_fraction_syntax(text, unit_index):
    prefix = text[max(0, unit_index - 64):unit_index].rstrip()
    if re.search(r"\btroy$", prefix, re.IGNORECASE):
        prefix = re.sub(r"\btroy$", "", prefix, flags=re.IGNORECASE).rstrip()
    if re.search(r"[\u00bc-\u00be\u2150-\u215e]$", prefix):
        return True
    if re.search(r"(?:^|\s)[+-]?\s*/\s*\d+$", prefix):
        return True
    expression_match = re.search(r"([+-]?\d(?:[\d\s/]*\d)?)$", prefix)
    expression = expression_match.group(1) if expression_match else None
    if not expression or "/" not in expression:
        return False
    simple_fraction = re.search(r"(?:(\d+)\s+)?(\d+)\s*/\s*(\d+)$", expression)
    if not simple_fraction:
        return True
    leading_integer = simple_fraction.group(1)
    year_prefix = re.match(r"^((?:17|18|19|20)\d{2})\s+", expression)
    if year_prefix:
        return False
    return _parse_fraction_weight(expression) is None


def analyze_explicit_weights(text):
    if not isinstance(text, str) or not text.strip():
        return {"weights": [], "invalid": False}
    if len(text) > MAX_SEARCH_TERM_LENGTH:
        return {"weights": [], "invalid": True}

    normalized = re.sub(r"\bone\s+(?:troy\s+)?(?:ounces?|ozt|ozs?)\b", "1 oz", text.lower())
    tokens = re.findall(r"[a-z0-9]+", normalized)
    canonical_sorted_order = all(left <= right for left, right in zip(tokens, tokens[1:]))
    ounce_unit_count = len(list(OUNCE_UNIT_PATTERN.finditer(normalized)))
    weights = set()
    invalid = False

    for unit in OUNCE_UNIT_PATTERN.finditer(normalized):
        if unit.start() > 0 and re.match(r"[a-z_]", normalized[unit.start() - 1]):
            continue
        if _has_invalid_fraction_syntax(normalized, unit.start()):
            invalid = True
            continue
        literal = _numeric_expression_before_unit(normalized, unit.start())
        if not literal:
            continue
        if "/" in literal:
            ounces = _parse_fraction_weight(literal)
            if ounces is None:
                invalid = True
            else:
                weights.add(ounces)
            continue
        ounces = _parse_numeric_weight(literal)
        if ounces is None:
            invalid = True
        else:
            weights.add(round(ounces, 6))

    has_standalone_ounce = bool(re.search(r"(?:^|[^a-z_])(?:ounces?|ozt|ozs?)\b", normalized))
    has_historical_eagle_denomination = (
        bool(re.search(r"\b(?:classic|head|indian|liberty)\b", normalized))
        and bool(re.search(r"\beagle\b", normalized))
        and not bool(re.search(r"\bamerican\b", normalized))
    )
    for word, ounces in WORD_WEIGHTS.items():
        is_historical_eagle_word = word in ("half", "quarter") and has_historical_eagle_denomination
        is_known_bare_denomination = (
            word == "half"
            and bool(re.search(r"\b(?:walking liberty|kennedy|franklin|barber|capped bust|seated liberty)\b", normalized))
        ) or (
            word == "quarter"
            and bool(re.search(r"\b(?:washington|standing liberty|barber|america beautiful)\b", normalized))
        )
        for occurrence in re.finditer(rf"\b{word}\b", normalized):
            before = normalized[:occurrence.start()]
            after = normalized[occurrence.end():]
            follows_weight_denomination = bool(re.search(
                r"\b(?:half|quarter|tenth|twentieth)[\s-]+(?:dollars?|cents?)[\s-]+$", before
            ))
            is_immediate_denomination = bool(
                re.match(r"[\s-]+(?:dollars?|cents?|eagles?)\b", after)
                or (not follows_weight_denomination and re.search(r"\b(?:dollars?|cents?)[\s-]+$", before))
            )
            is_descriptive_ordinal = bool(re.match(r"[\s-]+(?:anniversary|edition|commemorative)\b", after))
            followed_by_ounce = bool(re.match(r"[\s-]+(?:troy[\s-]+)?(?:ounces?|ozt|ozs?)\b", after))
            preceded_by_ounce = bool(re.search(r"\b(?:ounces?|ozt|ozs?)[\s-]+$", before))
            sorted_key_weight = (
                canonical_sorted_order and not is_immediate_denomination
                and not is_historical_eagle_word and not is_known_bare_denomination
            )
            is_weight_word = (followed_by_ounce and not is_immediate_denomination and not is_descriptive_ordinal) or (
                preceded_by_ounce and not follows_weight_denomination
                and not is_immediate_denomination and not is_descriptive_ordinal
            ) or (
                ounce_unit_count > 1 and not is_immediate_denomination and not is_descriptive_ordinal
                and not is_historical_eagle_word and not is_known_bare_denomination
            ) or (sorted_key_weight and not followed_by_ounce and not preceded_by_ounce)
            if has_standalone_ounce and is_weight_word:
                weights.add(ounces)
                break

    return {"weights": sorted(weights), "invalid": invalid}


def extract_explicit_weights(text):
    return analyze_explicit_weights(text)["weights"]


def has_contradictory_weights(text):
    analysis = analyze_explicit_weights(text)
    return analysis["invalid"] or len(analysis["weights"]) > 1


def analyze_explicit_weight_sources(*sources):
    weights = set()
    invalid = False
    for source in sources:
        analysis = analyze_explicit_weights(source)
        invalid = invalid or analysis["invalid"]
        weights.update(analysis["weights"])
    return {"weights": sorted(weights), "invalid": invalid}


def has_contradictory_weight_sources(*sources):
    analysis = analyze_explicit_weight_sources(*sources)
    return analysis["invalid"] or len(analysis["weights"]) > 1
