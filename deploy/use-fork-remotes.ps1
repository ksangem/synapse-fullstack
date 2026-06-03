# Point this clone at YOUR fork for CI/CD (upstream = ksangem main repo)
$ErrorActionPreference = 'Stop'
Set-Location 'C:\inetpub\wwwroot\synapse-fullstack'

$fork = 'https://github.com/ranjanpradyot/synapse-fullstack.git'
$upstream = 'https://github.com/ksangem/synapse-fullstack.git'

if (git remote get-url origin 2>$null) { git remote rename origin upstream 2>$null }
if (git remote get-url fork 2>$null) { git remote remove fork 2>$null }

git remote add origin $fork
if (-not (git remote get-url upstream 2>$null)) { git remote add upstream $upstream }

Write-Host 'Remotes:'
git remote -v
Write-Host ''
Write-Host 'Push CI/CD changes:  git push origin master'
Write-Host 'Sync from main repo: git fetch upstream && git merge upstream/master'
Write-Host 'Actions dashboard:   https://github.com/ranjanpradyot/synapse-fullstack/actions'
