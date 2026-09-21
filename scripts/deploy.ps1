# 一键部署：跑测试 → 同步共享模块 → 准备页面文件 → 递增版本号 → 部署云函数 → 配置访问路径
#
# 用法（在项目根目录）：
#   powershell -File scripts/deploy.ps1              # 部署三个云函数 + 页面托管
#   powershell -File scripts/deploy.ps1 -Hosting     # 顺便推一份到静态托管（默认域名会强制下载，见 README）
#   powershell -File scripts/deploy.ps1 -SkipTests   # 跳过测试（不推荐）
#
# 为什么要有这个脚本：
#   1. index.html 里的 ?v= 必须每次改 css/js 后换掉，否则 CDN 和浏览器会一直用旧脚本
#      （静态托管的 Cache-Control 是一年，手动改很容易忘）——这里自动换成当前时间戳
#   2. shared/*.js 是页面和云函数共用的唯一一份代码，云函数没法 require 项目外层目录，
#      所以部署前把它复制进各函数的 lib/ 目录（已 gitignore，不要手改）
#   3. 页面文件要复制一份进 cloudfunctions/site/public/，由 site 函数直接吐出去
#      （静态托管默认域名回源会加 Content-Disposition: attachment，页面会被当文件下载）

param(
    [switch]$Hosting,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$envId = 'trae-projects-4g5aob6ufac38569'
$functions = @('site', 'product-api', 'expire-notify')
$webFiles = @('index.html', 'styles.css', 'script.js', 'sw.js', 'manifest.json', 'html5-qrcode.min.js')
$webDirs = @('icons', 'shared')

Set-Location $root

Write-Host '== 1/6 单元测试 ==' -ForegroundColor Cyan
if ($SkipTests) {
    Write-Host '已跳过（-SkipTests）' -ForegroundColor Yellow
} else {
    node --test "tests/*.test.js"
    if ($LASTEXITCODE -ne 0) { throw '测试未通过，已中止部署' }
}

Write-Host '== 2/6 同步 shared/ 到各云函数的 lib/ ==' -ForegroundColor Cyan
foreach ($fn in $functions) {
    $libDir = Join-Path $root "cloudfunctions/$fn/lib"
    New-Item -ItemType Directory -Force -Path $libDir | Out-Null
    Copy-Item "$root/shared/*.js" $libDir -Force
    Write-Host "  → cloudfunctions/$fn/lib/"
}

Write-Host '== 3/6 准备页面文件（cloudfunctions/site/public/）==' -ForegroundColor Cyan
$sitePublic = Join-Path $root 'cloudfunctions/site/public'
if (Test-Path $sitePublic) { Remove-Item $sitePublic -Recurse -Force }
New-Item -ItemType Directory -Force -Path $sitePublic | Out-Null
foreach ($file in $webFiles) {
    Copy-Item (Join-Path $root $file) $sitePublic -Force
}
foreach ($dir in $webDirs) {
    Copy-Item (Join-Path $root $dir) $sitePublic -Recurse -Force
}
Write-Host "  → $((Get-ChildItem $sitePublic -Recurse -File).Count) 个文件"

Write-Host '== 4/6 递增 index.html 里的资源版本号 ==' -ForegroundColor Cyan
$indexPath = Join-Path $root 'index.html'
$stamp = Get-Date -Format 'yyyyMMddHHmm'
$html = Get-Content $indexPath -Raw -Encoding UTF8
$bumped = [regex]::Replace($html, '\?v=[0-9A-Za-z\.]+', "?v=$stamp")
if ($bumped -ne $html) {
    Set-Content $indexPath -Value $bumped -NoNewline -Encoding UTF8
    # 版本号变了，页面文件要重新复制一份
    Copy-Item $indexPath $sitePublic -Force
    Write-Host "  → ?v=$stamp"
} else {
    Write-Host '  → 没有需要替换的版本号' -ForegroundColor Yellow
}

Write-Host '== 5/6 部署云函数 ==' -ForegroundColor Cyan
foreach ($fn in $functions) {
    Write-Host "  部署 $fn ..."
    tcb fn deploy $fn -e $envId --dir "cloudfunctions/$fn" --runtime Nodejs20.19 --force
    if ($LASTEXITCODE -ne 0) { throw "云函数 $fn 部署失败" }

    # 部署会重置环境变量，所以紧接着按 cloudbaserc.json（引用 .env.local）重新写一遍
    '1' | tcb config update fn $fn -e $envId | Out-Null
    Write-Host "  → $fn 环境变量已应用"
}

Write-Host '== 6/6 HTTP 访问服务 ==' -ForegroundColor Cyan
$services = tcb service list -e $envId 2>&1 | Out-String
if ($services -notmatch 'product-api') {
    tcb service create -p api -f product-api -e $envId
    Write-Host '  → 已创建 /api → product-api'
} else {
    Write-Host '  → /api 已存在，跳过'
}
if ($services -notmatch '\bsite\b') {
    tcb service create -p app -f site -e $envId
    Write-Host '  → 已创建 /app → site'
} else {
    Write-Host '  → /app 已存在，跳过'
}

if ($Hosting) {
    Write-Host '== 追加：推一份到静态托管 ==' -ForegroundColor Cyan
    # 注意：本环境的默认域名回源时平台会追加 Content-Disposition: attachment，
    # 页面会被浏览器当成文件下载而不是打开（连云函数响应也一样，实测平台会覆盖函数自己写的 inline）。
    # 所以这一份只是备份：等你绑了自定义域名（需要域名 + 备案）才具备真正的页面入口能力。
    $stage = Join-Path $root '.deploy-tmp'
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage | Out-Null
    foreach ($file in $webFiles) { Copy-Item (Join-Path $root $file) $stage -Force }
    foreach ($dir in $webDirs) { Copy-Item (Join-Path $root $dir) $stage -Recurse -Force }

    tcb hosting deploy $stage -e $envId --entry index.html --verify
    if ($LASTEXITCODE -ne 0) { throw '静态页面发布失败' }
    Remove-Item $stage -Recurse -Force
    Write-Host '提醒：默认域名打开页面会变成下载（平台策略），绑自定义域名后这一份才有意义' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
Write-Host '页面入口（现在唯一可用）：https://halcyon0207.github.io/my-trae_projects/' -ForegroundColor Green
Write-Host '备用入口（等平台默认域名策略解除或绑自定义域名后可用）：https://trae-projects-4g5aob6ufac38569-1421597865.ap-shanghai.app.tcloudbase.com/app/' -ForegroundColor DarkGray
