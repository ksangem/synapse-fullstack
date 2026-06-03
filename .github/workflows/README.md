# GitHub Actions workflows

| Workflow | Trigger | Runner | Purpose |
|----------|---------|--------|---------|
| [frontend-ci.yml](frontend-ci.yml) | PR, push, manual | `ubuntu-latest` | Lint + build + artifact |
| [backend-ci.yml](backend-ci.yml) | PR, push, manual | `ubuntu-latest` | Test + build + artifact |
| [frontend-deploy.yml](frontend-deploy.yml) | After FE CI, manual | `self-hosted` Windows `synapse` | IIS deploy |
| [backend-deploy.yml](backend-deploy.yml) | After BE CI, manual | `self-hosted` Windows `synapse` | API deploy + health |
| [ci-dashboard.yml](ci-dashboard.yml) | Every 6h, push, manual | `ubuntu-latest` | Status table |

**Open the dashboard:** [github.com/ksangem/synapse-fullstack/actions](https://github.com/ksangem/synapse-fullstack/actions)
