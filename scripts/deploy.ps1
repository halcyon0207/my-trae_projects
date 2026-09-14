# 一键部署：跑测试 → 同步共享模块 → 递增版本号 → 部署云函数 → 配环境变量 → （可选）发布静态页面
#
# 用法（在项目根目录）：
#   powershell -File scripts/deploy.ps1                # 只部署两个云函数
#   powershell -File scripts/deploy.ps1 -Hosting       # 顺便发布静态页面到 CloudBase
#   powershell -File scripts/deploy.ps1 -SkipTests     # 跳过测试（不推荐）
#
# 为什么要有这个脚本：
#   1. index.html 里的 ?v= 必须每次改 css/js 后换掉，否则 CDN 和浏览器会一直用旧脚本
#      （静态托管的 Cache-Control 是一年，手动改很容易忘）——这里自动换成当前时间戳
#   2. shared/*.js 是页面和云函数共用的唯一一份代码，云函数没法 require 到项目外层目录，
#      所以部署前把它复制进各函数的 lib/ 目录（该目录已 gitignore，不要手改）

param(
    [switch]$Hosting,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$envId = 'trae-projects-4g5aob6ufac38569'
$functions = @('product-api', 'expire-notify')

Set-Location $root

Write-Host '== 1/5 单元测试 ==' -ForegroundColor Cyan
if ($SkipTests) {
    Write-Host '已跳过（-SkipTests）' -ForegroundColor Yellow
} else {
    node --test "tests/*.test.js"
    if ($LASTEXITCODE -ne 0) { throw '测试未通过，已中止部署' }
}

Write-Host '== 2/5 同步 shared/ 到各云函数的 lib/ ==' -ForegroundColor Cyan
foreach ($fn in $functions) {
    $libDir = Join-Path $root "cloudfunctions/$fn/lib"
    New-Item -ItemType Directory -Force -Path $libDir | Out-Null
    Copy-Item "$root/shared/*.js" $libDir -Force
    Write-Host "  → cloudfunctions/$fn/lib/"
}

Write-Host '== 3/5 递增 index.html 里的资源版本号 ==' -ForegroundColor Cyan
$indexPath = Join-Path $root 'index.html'
$stamp = Get-Date -Format 'yyyyMMddHHmm'
$html = Get-Content $indexPath -Raw -Encoding UTF8
$bumped = [regex]::Replace($html, '\?v=[0-9A-Za-z\.]+', "?v=$stamp")
if ($bumped -ne $html) {
    Set-Content $indexPath -Value $bumped -NoNewline -Encoding UTF8
    Write-Host "  → ?v=$stamp"
} else {
    Write-Host '  → 没有需要替换的版本号' -ForegroundColor Yellow
}

Write-Host '== 4/5 部署云函数 ==' -ForegroundColor Cyan
foreach ($fn in $functions) {
    Write-Host "  部署 $fn ..."
    tcb fn deploy $fn -e $envId --dir "cloudfunctions/$fn" --runtime Nodejs20.19 --force
    if ($LASTEXITCODE -ne 0) { throw "云函数 $fn 部署失败" }

    # 部署会重置环境变量，所以紧接着按 cloudbaserc.json（引用 .env.local）重新写一遍
    '1' | tcb config update fn $fn -e $envId | Out-Null
    Write-Host "  → $fn 环境变量已应用"
}

Write-Host '== 5/5 HTTP 访问服务 ==' -ForegroundColor Cyan
$services = tcb service list -e $envId 2>&1 | Out-String
if ($services -notmatch 'product-api') {
    tcb service create -p api -f product-api -e $envId
    Write-Host '  → 已创建 /api → product-api'
} else {
    Write-Host '  → /api 已存在，跳过'
}

if ($Hosting) {
    Write-Host '== 发布静态页面到 CloudBase ==' -ForegroundColor Cyan
    # 先复制到暂存目录再上传：直接传项目根目录会去遍历 .git（里面的文件没有读权限），
    # 也会把云函数、测试、脚本一起传上去
    $stage = Join-Path $root '.deploy-tmp'
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage | Out-Null

    foreach ($file in @('index.html', 'styles.css', 'script.js', 'sw.js', 'manifest.json', 'html5-qrcode.min.js')) {
        Copy-Item (Join-Path $root $file) $stage -Force
    }
    Copy-Item (Join-Path $root 'icons') $stage -Recurse -Force
    Copy-Item (Join-Path $root 'shared') $stage -Recurse -Force

    tcb hosting deploy $stage -e $envId --entry index.html --verify
    if ($LASTEXITCODE -ne 0) { throw '静态页面发布失败' }
    Remove-Item $stage -Recurse -Force
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
if (-not $Hosting) {
    Write-Host '静态页面未发布：加 -Hosting 参数可一并发布，或照旧推到 GitHub Pages。' -ForegroundColor Yellow
}
