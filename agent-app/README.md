# Managed Agent Client

Minimal Python client that streams from a pre-existing Anthropic Managed Agent.

- Agent: `agent_011Ca5fHbcWmKbCXyg1REXML`
- Environment: `env_01M8uBartNQvNF6yHt6mgR2j`

## Run

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python main.py "your prompt here"
```

The script creates a session, opens the event stream, sends one `user.message`,
prints `agent.message` text as it streams, and exits on `session.status_idle`.
