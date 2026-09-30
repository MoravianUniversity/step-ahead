"""
pdb-driven tracer that builds one value-history table per function call.
"""

from __future__ import annotations

import io
import json
import dis
import pdb
import sys
import traceback
import types
from typing import Any


USER_FILENAME = "<user>"
MAX_STEPS = 10_000
SKIP_NAMES = {
    "__builtins__",
    "__name__",
    "__package__",
    "__loader__",
    "__spec__",
    "__doc__",
    "__annotations__",
}


class TraceLimitExceeded(RuntimeError):
    pass


def _safe_repr(value: Any) -> str:
    try:
        text = repr(value)
    except Exception:
        return "<unreprable>"
    if len(text) > 200:
        return text[:197] + "..."
    return text


def _is_user_frame(frame) -> bool:
    return frame.f_code.co_filename == USER_FILENAME


def _call_site_span(parent_frame) -> dict[str, int] | None:
    """
    Map the parent's f_lasti to a source column span for the active CALL.

    pdb/bdb do not expose 'which call on this line' directly, but at call time
    the caller's f_lasti points at the CALL opcode; Python 3.11+ positions
    give column offsets for that instruction.
    """
    lasti = parent_frame.f_lasti
    matched = None
    nearest_call = None
    for instr in dis.get_instructions(parent_frame.f_code):
        positions = instr.positions
        if positions is None or positions.lineno is None:
            continue
        if positions.col_offset is None:
            continue
        span = {
            "line": positions.lineno,
            "colOffset": positions.col_offset,
            "endColOffset": (
                positions.end_col_offset
                if positions.end_col_offset is not None
                else positions.col_offset + 1
            ),
        }
        if instr.offset == lasti:
            matched = span
            break
        if "CALL" in instr.opname and instr.offset <= lasti:
            nearest_call = span
    return matched or nearest_call


def _call_site_from_callee(frame) -> dict[str, int] | None:
    parent = frame.f_back
    if parent is None or not _is_user_frame(parent):
        return None
    return _call_site_span(parent)


def _param_names(frame) -> list[str]:
    if frame.f_code.co_name == "<module>":
        return []
    code = frame.f_code
    names: list[str] = []
    total = code.co_argcount + code.co_kwonlyargcount
    names.extend(code.co_varnames[:total])
    idx = total
    if code.co_flags & 0x04:  # CO_VARARGS
        names.append(code.co_varnames[idx])
        idx += 1
    if code.co_flags & 0x08:  # CO_VARKEYWORDS
        names.append(code.co_varnames[idx])
    return names


class AutoTracePdb(pdb.Pdb):
    """Non-interactive pdb that records local value histories per call."""

    def __init__(self, output: io.StringIO) -> None:
        # Provide a stdin so pdb never tries to read from a missing TTY.
        super().__init__(stdin=io.StringIO("s\n" * (MAX_STEPS + 100)), stdout=io.StringIO())
        self.quitting = False
        self._output = output
        self._tables: list[dict[str, Any]] = []
        self._timeline: list[dict[str, Any]] = []
        self._stack: list[str] = []
        self._open: dict[int, dict[str, Any]] = {}
        self._prev_locals: dict[int, dict[str, str]] = {}
        self._call_counts: dict[str, int] = {}
        self._step_count = 0
        self._next_table_id = 1

    def user_line(self, frame) -> None:  # type: ignore[override]
        if not _is_user_frame(frame):
            self.set_step()
            return
        self._bump_steps()
        self._record_stop(frame)
        self.set_step()

    def user_call(self, frame, argument_list) -> None:  # type: ignore[override]
        if not _is_user_frame(frame):
            self.set_step()
            return
        self._bump_steps()
        self._open_call(frame)
        self._record_stop(frame)
        self.set_step()

    def user_return(self, frame, return_value) -> None:  # type: ignore[override]
        if not _is_user_frame(frame):
            self.set_step()
            return
        self._bump_steps()
        table = self._open.get(self._frame_key(frame))
        pending_return: str | None = None
        if table is not None and frame.f_code.co_name != "<module>":
            pending_return = _safe_repr(return_value)

        # Skip a duplicate stop only when user_line just recorded this same
        # frame/line (nothing else ran in between). Do NOT skip when returning
        # into an outer frame that still needs a resume step — e.g. the module
        # line `print(foo(4))` after foo returns.
        should_record = True
        if table is not None and table["steps"] and self._timeline:
            last = table["steps"][-1]
            same_line = last["line"] == frame.f_lineno
            same_locals = last["locals"] == self._filter_locals(frame)
            latest_is_this_frame = self._timeline[-1]["tableId"] == table["id"]
            if same_line and same_locals and latest_is_this_frame:
                should_record = False
        if should_record:
            self._record_stop(frame)

        if table is not None and pending_return is not None:
            table["returnValue"] = pending_return
            for i in range(len(self._timeline) - 1, -1, -1):
                if self._timeline[i]["tableId"] == table["id"]:
                    table["returnTimelineIndex"] = i
                    break
        self._close_call(frame)
        if table is not None and pending_return is not None:
            self._record_return_to_call_site(frame.f_back, table)
        self.set_step()

    def user_exception(self, frame, exc_info) -> None:  # type: ignore[override]
        if _is_user_frame(frame):
            self._bump_steps()
            self._record_stop(frame)
        self.set_step()

    def _bump_steps(self) -> None:
        self._step_count += 1
        if self._step_count > MAX_STEPS:
            raise TraceLimitExceeded(
                f"Trace exceeded {MAX_STEPS} steps (possible infinite loop)."
            )

    def _frame_key(self, frame) -> int:
        return id(frame)

    def _iter_tracked_locals(self, frame):
        for name, value in frame.f_locals.items():
            if name in SKIP_NAMES or name.startswith("__"):
                continue
            if isinstance(
                value,
                (
                    types.FunctionType,
                    types.BuiltinFunctionType,
                    types.MethodType,
                    type,
                    types.ModuleType,
                ),
            ):
                continue
            yield name, value

    def _filter_locals(self, frame) -> dict[str, str]:
        return {
            name: _safe_repr(value) for name, value in self._iter_tracked_locals(frame)
        }

    def _local_types(self, frame) -> dict[str, str]:
        return {
            name: type(value).__name__
            for name, value in self._iter_tracked_locals(frame)
        }

    def _arg_reprs(self, frame) -> list[str]:
        """Capture argument values at call time, in parameter order."""
        if frame.f_code.co_name == "<module>":
            return []
        code = frame.f_code
        locals_ = frame.f_locals
        parts: list[str] = []
        positional = code.co_argcount
        kwonly = code.co_kwonlyargcount
        for i in range(positional):
            name = code.co_varnames[i]
            if name in locals_:
                parts.append(_safe_repr(locals_[name]))
        for i in range(positional, positional + kwonly):
            name = code.co_varnames[i]
            if name in locals_:
                parts.append(f"{name}={_safe_repr(locals_[name])}")
        idx = positional + kwonly
        if code.co_flags & 0x04:  # CO_VARARGS
            star = code.co_varnames[idx]
            idx += 1
            for value in locals_.get(star, ()):
                parts.append(_safe_repr(value))
        if code.co_flags & 0x08:  # CO_VARKEYWORDS
            kw = code.co_varnames[idx]
            for key, value in (locals_.get(kw) or {}).items():
                parts.append(f"{key}={_safe_repr(value)}")
        return parts

    def _open_call(self, frame) -> None:
        key = self._frame_key(frame)
        if key in self._open:
            return
        name = frame.f_code.co_name
        display = "<module>" if name == "<module>" else name
        count = self._call_counts.get(display, 0) + 1
        self._call_counts[display] = count
        table = {
            "id": f"t{self._next_table_id}",
            "functionName": display,
            "args": self._arg_reprs(frame),
            "returnValue": None,
            "returnTimelineIndex": None,
            "callSite": _call_site_from_callee(frame),
            "parameters": _param_names(frame),
            "callIndex": count,
            "variables": [],
            "types": {},
            "histories": {},
            "steps": [],
        }
        self._next_table_id += 1
        self._open[key] = table
        self._prev_locals[key] = {}
        self._tables.append(table)
        self._stack.append(table["id"])

    def _close_call(self, frame) -> None:
        key = self._frame_key(frame)
        table = self._open.pop(key, None)
        self._prev_locals.pop(key, None)
        if table is not None:
            table_id = table["id"]
            # Pop this frame (and any stragglers above it) from the stack.
            while self._stack:
                popped = self._stack.pop()
                if popped == table_id:
                    break

    def _ensure_open(self, frame) -> dict[str, Any] | None:
        key = self._frame_key(frame)
        if key not in self._open and _is_user_frame(frame):
            self._open_call(frame)
        return self._open.get(key)

    def _record_stop(self, frame) -> None:
        if not _is_user_frame(frame):
            return
        table = self._ensure_open(frame)
        if table is None:
            return
        key = self._frame_key(frame)
        current = self._filter_locals(frame)
        current_types = self._local_types(frame)
        previous = self._prev_locals.get(key, {})

        for name, value in current.items():
            if name not in table["histories"]:
                table["histories"][name] = []
                table["variables"].append(name)
                table["types"][name] = current_types.get(name, "object")
            if previous.get(name) != value:
                table["histories"][name].append(value)

        table["steps"].append(
            {
                "line": frame.f_lineno,
                "locals": dict(current),
            }
        )
        self._timeline.append(
            {
                "tableId": table["id"],
                "line": frame.f_lineno,
                "stepIndex": len(table["steps"]) - 1,
                "stack": list(self._stack),
                "stdoutLen": len(self._output.getvalue()),
            }
        )
        self._prev_locals[key] = current

    def _record_return_to_call_site(self, parent_frame, child_table) -> None:
        """Pause on the caller's call site before normal tracing resumes."""
        call_site = child_table.get("callSite")
        if (
            parent_frame is None
            or not _is_user_frame(parent_frame)
            or call_site is None
        ):
            return
        parent_table = self._open.get(self._frame_key(parent_frame))
        if parent_table is None or not parent_table["steps"]:
            return
        self._timeline.append(
            {
                "tableId": parent_table["id"],
                "line": call_site["line"],
                "stepIndex": len(parent_table["steps"]) - 1,
                "kind": "callReturn",
                "callSiteTableId": child_table["id"],
                "stack": list(self._stack),
                "stdoutLen": len(self._output.getvalue()),
            }
        )


def run_user_code(source: str) -> dict[str, Any]:
    """Compile and run source under AutoTracePdb; return tables + stdout/error."""
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    tracer = AutoTracePdb(stdout_buf)
    error: str | None = None

    old_stdout, old_stderr = sys.stdout, sys.stderr
    try:
        sys.stdout = stdout_buf
        sys.stderr = stderr_buf
        code = compile(source, USER_FILENAME, "exec")
        globals_dict: dict[str, Any] = {"__name__": "__main__"}
        tracer.reset()
        sys.settrace(tracer.trace_dispatch)
        try:
            tracer.set_step()
            exec(code, globals_dict, globals_dict)
        finally:
            sys.settrace(None)
    except TraceLimitExceeded as exc:
        error = str(exc)
    except SystemExit:
        pass
    except Exception:
        error = traceback.format_exc()
    finally:
        sys.settrace(None)
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    stdout_text = stdout_buf.getvalue()
    stderr_text = stderr_buf.getvalue()
    if stderr_text and not error:
        error = stderr_text

    return {
        "tables": tracer._tables,
        "timeline": tracer._timeline,
        "stdout": stdout_text,
        "error": error,
    }


def run_user_code_json(source: str) -> str:
    return json.dumps(run_user_code(source))
