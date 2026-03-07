I want to make a new version of Codex App Server support mixing concepts (and possibly starting from) one of these two branches:

- acp-telegram-value-reapply-main - This has Telegram integration work that makes the /acp command and sub-commands work in Telegram, as well as /focus and /unfocus that bind a Telegram Topic to a subagent like ACP or others. This does a nice job of handling response relay and typing indicators and configs but DOES NOT handle asking the user for approval or relaying approval - it can only operate in allow all, allow read only, or deny all modes.
- codex-app-server-bound - This has Codex App Server protocol files and a new /codex command. This does not bind Topics but it WILL route responess back to the correct Topic in a Group in TG. It has a robust but not perfect approval mechanism using buttons in TG. It creates persistent threads in Codex. It does not have functions to bind a topic to a thread in Codex and does not offer a way to resume a thread or anything like that.

I want Codex App Server to be the best-in-class development experience. I attached my screenshots of requirements.

I like the concept of binding a topic to a Codex thread. The way I would typically work would be one of:

1. Start a thread in a project on Codex Desktop with a worktree, branch, etc.
   A. Do some work on Codex Desktop
   B. Run out to the store and want to get an update on this topic...
   C. Be able to ask OpenClaw to join the Codex thread in a Topic I have open - I'd want to ask in free form text something like `/codex join the thread in openclaw project that we had for fixing exec approvals` and have OpenClaw get the list of threads in the openclaw project, find the most recent one that mentions approvals, then bind the current topic to that thread and send the most recent messages from that thread into the Topic - If the thread in Codex is waiting at an approval, replay the approval request into the TG Topic and let me approve it once, approve that prefix for the session, deny it, or steer with a free form response
2. Use `/codex new` or maybe `/codex spawn` to start a new thread from Telegram on the go in a Topic. Have that thread get bound to the current Topic or DM (basically take over whatever context we're in under we're done, by default, unless we specifically ask for it to be a background detached thread)
   A. Setup a worktree, have Codex run the environment setup if there is one configured
   B. Setup a branch when asked that is attached to that worktree
   C. Take a new requirement from me on the go via Siri voice dictation in Telegram or via a TTS or just by tapping on the keyboard.
   D. Go off and do some work, ping me for approvals, etc.
   E. When I get home, I pull up Codex Desktop and continue the work on my home machine

# Goals

1. Detached channel agnostic remote control for Codex
2. ALL the features I have in Codex in OpenClaw's channels:
   A. All the slash commands from codex to be slash commands in TG when bound - Possibly prefix them all so like `/codex_review` would map to Codex's `/review` slash command - this would allow us to provide the most inline context docs on each command without having to run them just to see what subcommands they support. I don't think we want to expose them as `/review` because they may conflict with OpenClaw built-in slash commands. I think we can get the full list of Codex slash commands over the App Server protocol. If any registered MCPs define their own slash command we'd want that exposed too.
3. Be able to detach from a Codex thread in my TG Topic like it's nothing: it's not going to lose or close the Codex thread. Codex will have it if I want to reattach to it. We will want to save the current binding of channel topic/thread to Codex thread so that on a gateway restart we'll still be connected to the right threads, if we want (we may imply that we need to resume the thread if we haven't since a restart on first message in that channel topic)
4. Support setting up worktrees and using environments - we could do this interactively with the user were we ask them if they want a work tree and they pick the answer with buttons, then we ask what source branch we should use and they pick with buttons or give a free-form answer, then we ask what env and they pick with buttons, etc. I'm imagining this would be part of `/codex new` and that it can accept free-form text that gets LLM processed but we might also want some params like `/acp spawn` has with `/codex new --cwd /Users/huntharo/github/jeerreview` to point to the project we want to start from (although we might still end up in a worktree at a different path)
5. Follow the ACP model very closely... in fact... if we have to copy their command names, so be it... spawn, steer, etc. etc.
   A. Use subagent IDs like ACP does so that we can pass them to `/focus [agent-id]` and it will "just work" (so don't ONLY use the Codex threadID... make sure it's scoped to work with `/focus`)
   B. Use the same attachment hook points that ACP did for request and response relay
   C. Approvals - This is one area where we will break away: we want to allow interactive approvals like we did on the other branch, right from the start
6. We do want to retain the `/codex list <filter>` command... that was pretty solid - could refine it, but it's useful to get the list of threads in a project that you can bind to
