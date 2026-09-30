"""Strict YAML loading: PyYAML *safe* loader, duplicate keys rejected, size-bounded."""
import yaml

from . import ImgsecError

MAX_BYTES = 64 * 1024 * 1024
_Base = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


class StrictLoader(_Base):  # pylint: disable=too-many-ancestors
    """Safe loader that refuses duplicate mapping keys — a duplicated ``image:`` must not let
    this scanner and the Kubernetes decoder disagree about which value wins."""


def _construct_mapping(loader, node, deep=False):
    seen = set()
    for key_node, _ in node.value:
        if key_node.tag == "tag:yaml.org,2002:merge":
            continue  # `<<:` merge keys may legitimately be overridden by explicit keys
        key = loader.construct_object(key_node, deep=deep)
        try:
            hashable = key in seen
        except TypeError:
            raise ImgsecError("render", f"unhashable mapping key at line {key_node.start_mark.line + 1}") from None
        if hashable:
            raise ImgsecError("render", f"duplicate key {key!r} at line {key_node.start_mark.line + 1}")
        seen.add(key)
    return yaml.SafeLoader.construct_mapping(loader, node, deep=deep)


StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping)


def load_all(text, origin):
    if isinstance(text, bytes):
        if len(text) > MAX_BYTES:
            raise ImgsecError("render", f"{origin}: larger than {MAX_BYTES} bytes")
        text = text.decode("utf-8", "strict")
    elif len(text) > MAX_BYTES:
        raise ImgsecError("render", f"{origin}: larger than {MAX_BYTES} bytes")
    try:
        return list(yaml.load_all(text, Loader=StrictLoader))  # noqa: S506 — StrictLoader is a SafeLoader
    except ImgsecError as e:
        raise ImgsecError("render", f"{origin}: {e.message}") from None
    except yaml.YAMLError as e:
        raise ImgsecError("render", f"{origin}: invalid YAML ({str(e).splitlines()[0]})") from None
    except UnicodeDecodeError:
        raise ImgsecError("render", f"{origin}: not UTF-8") from None


def dump_all(docs):
    return yaml.safe_dump_all(docs, sort_keys=False, default_flow_style=False, explicit_start=True)
