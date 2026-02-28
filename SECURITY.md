# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Ariadne, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email: **simon.rueba@gmail.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You should receive a response within 72 hours. We will work with you to understand and address the issue before any public disclosure.

## Scope

Ariadne is a local development tool that runs on the developer's machine. It:
- Reads and indexes source code files locally
- Stores data in a local SQLite database (`.ariadne/`)
- Does not make network requests
- Does not process untrusted input (all input comes from the local filesystem and Claude Code hooks)

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | Yes       |
