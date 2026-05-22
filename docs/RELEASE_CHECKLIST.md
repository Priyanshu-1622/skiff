# Release Checklist

Before publishing Skiff to GitHub:

## Code Quality
- [ ] All TypeScript checks pass (`pnpm typecheck`)
- [ ] Production build succeeds (`pnpm build`)
- [ ] No console.log statements in production code
- [ ] All TODO comments addressed or documented

## Documentation
- [ ] README.md is complete and accurate
- [ ] CONTRIBUTING.md exists
- [ ] SECURITY.md exists
- [ ] DEPLOYMENT.md exists
- [ ] CHANGELOG.md updated
- [ ] LICENSE contains full AGPL-3.0 text
- [ ] All links in documentation are valid

## Configuration
- [ ] .env.example has all required variables
- [ ] .gitignore excludes sensitive files
- [ ] package.json metadata is correct (author, repo URL)
- [ ] Docker Compose works (`docker compose up --build`)

## Security
- [ ] No hardcoded secrets or API keys
- [ ] Default cookie secret is removed or randomized
- [ ] Database credentials not committed
- [ ] No sensitive data in git history

## Testing
- [ ] Fresh install works (`rm -rf node_modules && pnpm install`)
- [ ] Development mode works (`pnpm dev`)
- [ ] Production build works
- [ ] Docker container starts and serves correctly
- [ ] Setup flow works (create master password)
- [ ] Unlock flow works
- [ ] Add host works
- [ ] Terminal connection works
- [ ] SSH config import works
- [ ] Password change works
- [ ] Dark/light theme toggle works
- [ ] Folder creation/deletion works

## GitHub
- [ ] Repository is public (or ready to be)
- [ ] Issue templates configured
- [ ] PR template configured
- [ ] Repository description is set
- [ ] Topics/tags added (ssh, terminal, self-hosted, etc.)
- [ ] Social preview image set (optional)

## Release
- [ ] Version bumped in package.json
- [ ] Git tag created (`git tag v0.1.0`)
- [ ] CHANGELOG.md updated
- [ ] Release notes drafted

## Post-Release
- [ ] Announcement on relevant communities (Reddit /r/selfhosted, etc.)
- [ ] Tweet/toot about release
- [ ] Add to awesome-selfhosted list
- [ ] Monitor issues for bugs
