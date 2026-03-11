Param(
  [string]$OutDir = "$PSScriptRoot\\wheels",
  [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu121"
)

$ErrorActionPreference = "Stop"

Write-Host "[prefetch] Output: $OutDir"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# We download torch/vision/audio plus common runtime deps that sometimes fail to fetch during docker builds.
# This turns your future docker builds into local installs (no公网重复下载).
$pkgs = @(
  "torch",
  "torchvision",
  "torchaudio",
  "filelock",
  "typing-extensions",
  "sympy",
  "networkx",
  "jinja2",
  "fsspec",
  "mpmath",
  "markupsafe"
)

Write-Host "[prefetch] Downloading wheels..."
python -m pip download `
  --dest $OutDir `
  --index-url $TorchIndexUrl `
  --extra-index-url "https://pypi.org/simple" `
  --only-binary=:all: `
  --no-deps `
  torch torchvision torchaudio

# download deps from PyPI (binary wheels preferred)
python -m pip download `
  --dest $OutDir `
  --index-url "https://pypi.org/simple" `
  --only-binary=:all: `
  $pkgs

Write-Host "[prefetch] Done. Wheel count:" (Get-ChildItem $OutDir -Filter *.whl | Measure-Object).Count

