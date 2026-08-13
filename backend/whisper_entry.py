import multiprocessing
import inspect

# torch tries to read its own source code at import time for a
# torch.compile()-related feature Whisper never uses. Bundled apps only
# ship compiled bytecode, not source text, so that read fails — this makes
# it return "" instead of crashing. Harmless: we never touch torch.compile().
_original_getsource = inspect.getsource
def _safe_getsource(obj):
    try:
        return _original_getsource(obj)
    except OSError:
        return ""
inspect.getsource = _safe_getsource

if __name__ == "__main__":
    # Must be the very first line inside this guard. Torch spawns helper
    # processes for parallel work — in a bundled executable those helpers
    # re-launch THIS SAME binary. Without freeze_support(), they try to run
    # the whole CLI again with mangled internal flags instead of quietly
    # doing their actual job, which is the "-B -S -I -c" error you saw.
    multiprocessing.freeze_support()

    from whisper.transcribe import cli
    cli()