# Contributing to Skiff

Thank you for considering contributing to Skiff! This document will help you get started.

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on what's best for the project and community

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/yourusername/skiff/issues)
2. If not, create a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (OS, Node version, browser)
   - Screenshots if applicable

### Suggesting Features

1. Check [Discussions](https://github.com/yourusername/skiff/discussions) to see if it's already proposed
2. Create a new discussion in the "Ideas" category
3. Describe the use case and why it would be valuable

### Pull Requests

1. **Fork** the repository
2. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes:**
   - Follow the existing code style
   - Add tests if applicable
   - Update documentation if needed
4. **Test your changes:**
   ```bash
   pnpm install
   pnpm typecheck
   pnpm build
   pnpm test
   ```
5. **Commit** with clear messages:
   ```bash
   git commit -m "feat: add SSH key upload feature"
   git commit -m "fix: resolve terminal resize bug"
   git commit -m "docs: update deployment guide"
   ```
6. **Push** to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
7. **Open a Pull Request** with:
   - Description of changes
   - Link to related issue (if any)
   - Screenshots/videos for UI changes

## Development Setup

```bash
# Clone your fork
git clone https://github.com/your-username/skiff.git
cd skiff

# Install dependencies
pnpm install

# Start dev servers
pnpm dev

# Run typechecks
pnpm typecheck

# Build for production
pnpm build
```

## Project Structure

```
skiff/
├── apps/
│   ├── web/          # React frontend
│   └── api/          # Fastify backend
├── packages/
│   └── shared/       # Shared types
├── .github/          # GitHub templates and workflows
└── docs/             # Documentation
```

## Code Style

- **TypeScript** strict mode
- **ESLint** + **Prettier** for formatting
- **Conventional Commits** preferred (feat, fix, docs, chore, etc.)
- **Descriptive variable names** over abbreviations
- **Comments** for non-obvious logic
- **Type safety** — avoid `any` when possible

## Testing Guidelines

- Add unit tests for new utility functions
- Add integration tests for new API routes
- Manual testing checklist for UI changes:
  - Test on Chrome, Firefox, Safari
  - Test dark and light themes
  - Test with empty state, full list, error states

## What We're Looking For

**High Priority:**
- Bug fixes
- Performance improvements
- Security enhancements
- Documentation improvements
- Test coverage

**Nice to Have:**
- New features (discuss first in Issues/Discussions)
- UI/UX improvements
- Accessibility improvements

## Questions?

- Open a [Discussion](https://github.com/yourusername/skiff/discussions)
- Comment on an existing Issue or PR
- Check existing documentation

Thank you for contributing! 🎉
