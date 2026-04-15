"""Minimal Managed Agents client.

Creates a session for a pre-existing agent, opens an event stream, sends one
user message, and prints agent.message text as it streams. Exits on
session.status_idle or any SDK error.
"""

import os
import sys

import anthropic

AGENT_ID = "agent_011Ca5fHbcWmKbCXyg1REXML"
ENVIRONMENT_ID = "env_01M8uBartNQvNF6yHt6mgR2j"


def main() -> int:
    prompt = " ".join(sys.argv[1:]) or "Hello!"

    client = anthropic.Anthropic()

    try:
        session = client.beta.sessions.create(
            agent=AGENT_ID,
            environment_id=ENVIRONMENT_ID,
        )
    except anthropic.APIError as e:
        print(f"Failed to create session: {e}", file=sys.stderr)
        return 1

    print(f"Session: {session.id}", file=sys.stderr)

    try:
        # Stream-first: open the stream before sending the kickoff event so we
        # don't miss early events.
        with client.beta.sessions.events.stream(session_id=session.id) as stream:
            client.beta.sessions.events.send(
                session_id=session.id,
                events=[
                    {
                        "type": "user.message",
                        "content": [{"type": "text", "text": prompt}],
                    }
                ],
            )

            for event in stream:
                if event.type == "agent.message":
                    for block in event.content:
                        if block.type == "text":
                            print(block.text, end="", flush=True)
                elif event.type == "session.status_idle":
                    print()
                    return 0
                elif event.type == "session.status_terminated":
                    print("\n[session terminated]", file=sys.stderr)
                    return 1
                elif event.type == "session.error":
                    print(f"\n[session error] {event}", file=sys.stderr)
                    return 1
    except anthropic.APIError as e:
        print(f"\nAPI error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n[interrupted]", file=sys.stderr)
        return 130

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
