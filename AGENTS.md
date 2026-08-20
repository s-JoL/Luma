# AGENTS.md

## Workspace

Two projects, nothing else: `luma/` (the chat, agent and image workstation) and
`ComfyUI/` (the local generation backend Luma drives over `127.0.0.1:8188`).
Luma's own conventions live in `luma/docs/`. Start at `luma/docs/00-product.md`
before changing it.

Luma needs Node 24 or newer (`node:sqlite`). On the Windows development machine
the only copy lives at `luma/runtime/node`, is not on the system PATH, and must
not be deleted or relocated — nothing there runs without it. That build is a
Windows one, so on macOS and Linux `scripts/common.sh` skips it and uses a Node
24 from PATH instead; scripts must resolve Node rather than assume `node` does.

`runtime/`, `run/` and `ComfyUI/` are installed per machine and gitignored.
Their absence in a checkout is not a fault to repair.

## Environment

Before changing ComfyUI, confirm the active Desktop installation, model path,
available disk space, GPU usage, running ComfyUI processes, and required custom nodes.
Operate on the active shared model directory, not an assumed or historical path.

## Downloads

Prefer ComfyUI Desktop's template downloader for officially supported workflows.
Otherwise use `comfy model download`; for large Hugging Face/Xet files and mirrors,
prefer `hf download` or `huggingface_hub` with `hf_xet`.

Downloads must bypass the proxy unless explicitly required. Download to a temporary
file or cache, then verify expected byte size and SHA-256 before installing.
Never use blind `curl --continue-at -` resume for Xet files. A filename or HTTP 200
response is not proof of a valid model.

For Python/PyPI installs in China, benchmark the official host and domestic mirrors
before waiting on a large wheel. On this machine, the Tsinghua PyPI mirror
(`https://pypi.tuna.tsinghua.edu.cn/simple`) was dramatically faster than both the
official PyPI file host and the Aliyun mirror. Install dependencies with the Tsinghua
index when it wins the live speed test. An exact `files.pythonhosted.org/packages/...`
wheel path can also be fetched from the matching
`https://pypi.tuna.tsinghua.edu.cn/packages/...` path.

Treat the official PyPI JSON API as the integrity authority: obtain the expected file
size and SHA-256 from `https://pypi.org/pypi/<package>/<version>/json`, download to a
`.download` file, verify the complete file, and only then rename it to the final wheel.
Do not trust a mirror solely because the transfer completed.

Keep exactly one writer per temporary download target. A timed-out shell command may
leave `curl` or another child process running in the background. Before retrying or
resuming, inspect active download processes and confirm the temporary file is no longer
open or growing. Never start a second download against the same `.download` path; stop
the stale process and quarantine or remove the partial file first. Use resume only when
the server's byte-range support is confirmed and no other process is writing the file.

If Windows Application Control blocks a newly downloaded package runner such as `uv`,
use a trusted installed or bundled Python 3.11/3.12 virtual environment instead of
weakening the system security policy.

## Workflows

Follow the model author's recommended sampler, scheduler, steps, CFG, resolution,
and companion files. Quality-only negative prompts may be used when they improve the
model; leave them empty when the architecture recommends that.

Keep quality and accelerated DMD2/Lightning/Turbo workflows separate.

## Safety Boundary

Safety filtering is already handled by dedicated upstream and downstream components.
Do not duplicate it inside ComfyUI workflows, prompts, negative prompts, conditioning,
gateway logic, or model selection. Do not add content-filtering terms, safety declarations,
blocked-word lists, refusal logic, safety LoRAs, or similar controls. ComfyUI should focus
only on generation quality and the requested workflow behavior.
