# 执行 powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\prefetch_torch_wheels.ps1
Param(
  # Where to place downloaded wheel files for Dockerfile COPY / local install usage.
  [string]$OutDir = (Join-Path $PSScriptRoot 'wheels'),
  # Which PyTorch CUDA wheel index to prefetch (e.g. cu121).
  [string]$TorchIndexUrl = 'https://download.pytorch.org/whl/cu121',

  # Pinned versions used by Docker/Dockerfile.pose.gpu (and documented in Dockerfile.*.gpu).
  [string]$TorchVersion = '2.6.0',
  [string]$TorchVisionVersion = '0.21.0',
  [string]$TorchAudioVersion = '2.6.0'
)

$ErrorActionPreference = 'Stop'

function Invoke-PipDownload {
  param(
    [Parameter(Mandatory)]
    [string[]]$PipArgs
  )

  $common = @(
    '-m', 'pip', 'download',
    '--dest', $OutDir,
    '--platform', 'manylinux2014_x86_64',
    '--python-version', '310',
    '--implementation', 'cp',
    '--abi', 'cp310',
    '--only-binary=:all:'
  )

  & python @common @PipArgs
  if ($LASTEXITCODE -ne 0) {
    throw "pip download failed (exit $LASTEXITCODE)"
  }
}

Write-Host "[prefetch] Output: $OutDir"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Download torch/vision/audio wheels + common heavy deps used by sam2/pose/depthrepair.
# Torch is fetched with --no-deps (smaller prefetch); Dockerfiles install with --find-links=/wheels
# plus PyTorch/PyPI indexes so nvidia-* CUDA dependency wheels still resolve at image build time.
$pkgs = @(
  # Core torch runtime deps (often pulled as transitive deps).
  'filelock',
  'typing-extensions',
  'sympy',
  'networkx',
  'jinja2',
  'fsspec',
  'mpmath',
  'markupsafe',

  # Numeric / image stack used across services.
  'numpy',
  'pillow',
  'scikit-image',
  'scipy',
  'opencv-python',
  'imageio[ffmpeg]',
  'matplotlib',

  # Pose/depth specific heavy deps.
  'trimesh[easy]',
  'pyglet',
  'huggingface_hub'
)

# PyTorch cu121 wheels are selected by --index-url (not by "==x.y.z+cu121" in pip spec;
# that form often fails for `pip download` with "No matching distribution found").
Write-Host "[prefetch] Downloading torch/vision/audio (Linux wheels, cp310) from ${TorchIndexUrl}..."
Invoke-PipDownload -PipArgs @(
  '--index-url', $TorchIndexUrl,
  '--extra-index-url', 'https://pypi.org/simple',
  '--no-deps',
  "torch==${TorchVersion}",
  "torchvision==${TorchVisionVersion}",
  "torchaudio==${TorchAudioVersion}"
)

Write-Host '[prefetch] Verifying downloaded torch wheels (filenames may not contain "cu121"; index selects CUDA build)...'
$torchWheels = @(Get-ChildItem -Path $OutDir -Filter "torch-${TorchVersion}-*.whl" -ErrorAction SilentlyContinue)
$tvWheels = @(Get-ChildItem -Path $OutDir -Filter "torchvision-${TorchVisionVersion}-*.whl" -ErrorAction SilentlyContinue)
$taWheels = @(Get-ChildItem -Path $OutDir -Filter "torchaudio-${TorchAudioVersion}-*.whl" -ErrorAction SilentlyContinue)
if ($torchWheels.Count -lt 1) {
  throw "[prefetch] No torch-${TorchVersion}-*.whl found under $OutDir. Check TorchIndexUrl / network / pip version."
}
if ($tvWheels.Count -lt 1) {
  Write-Warning "[prefetch] torchvision-${TorchVisionVersion}-*.whl not found (count=0)."
}
if ($taWheels.Count -lt 1) {
  Write-Warning "[prefetch] torchaudio-${TorchAudioVersion}-*.whl not found (count=0)."
}

Write-Host '[prefetch] Downloading common deps (Linux wheels where applicable)...'
Invoke-PipDownload -PipArgs (@('--index-url', 'https://pypi.org/simple') + $pkgs)

# xformers wheels declare a tight torch pin (e.g. torch==2.4.0) that conflicts with our CUDA stack.
# We still prefetch the binary wheel for offline installs; image build uses the torch version above.
Write-Host '[prefetch] Downloading xformers wheel only (--no-deps)...'
Invoke-PipDownload -PipArgs @(
  '--index-url', 'https://pypi.org/simple',
  '--no-deps',
  'xformers'
)

Write-Host "[prefetch] Removing stray torch wheels (keep torch==${TorchVersion} only)..."
$keepPrefix = "torch-${TorchVersion}-"
Get-ChildItem -Path $OutDir -Filter 'torch-*.whl' -ErrorAction SilentlyContinue |
  Where-Object { -not $_.Name.StartsWith($keepPrefix) } |
  Remove-Item -Force

$wheelCount = (Get-ChildItem -Path $OutDir -Filter '*.whl' -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "[prefetch] Done. Wheel count: $wheelCount"
