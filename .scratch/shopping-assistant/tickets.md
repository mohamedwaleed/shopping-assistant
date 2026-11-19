# Shopping Assistant implementation tickets

Status: published and verified

Parent: https://github.com/mohamedwaleed/shopping-assistant/issues/1

Numbers in the first column are local ticket numbers. Status as of wave 2: tickets 01-06 and 08-11 are merged to `main`; 07 was withdrawn; 32, 35, 36 and 12 onward are ready and unblocked in dependency order. The manifest `.scratch/shopping-assistant/ticket-drafts/manifest.json` carries per-ticket status, PR and commit.

| Local | GitHub | Ticket | Blocked by GitHub issues |
|---|---|---|---|
| 01 | [#2 CLOSED](https://github.com/mohamedwaleed/shopping-assistant/issues/2) | Run a catalogue-to-screen walking skeleton | None |
| 02 | [#3 CLOSED](https://github.com/mohamedwaleed/shopping-assistant/issues/3) | Create the first administrator and private workspace | #2 |
| 03 | [#4 CLOSED](https://github.com/mohamedwaleed/shopping-assistant/issues/4) | Manage devices, sessions and password changes | #3 |
| 04 | [#5 CLOSED](https://github.com/mohamedwaleed/shopping-assistant/issues/5) | Configure SMTP and test transactional delivery | #3 |
| 05 | [#6 CLOSED](https://github.com/mohamedwaleed/shopping-assistant/issues/6) | Invite shoppers, change email and recover passwords (screens in 35) | #4, #5 |
| 06 | [#7 CLOSED](https://github.com/mohamedwaleed/shopping-assistant/issues/7) | Add optional authenticator two-factor authentication | #4, #6 |
| 07 | [#8 WITHDRAWN](https://github.com/mohamedwaleed/shopping-assistant/issues/8) | Manage the Netherlands retailer registry | #3 |
| 08 | [#9 CLOSED](https://github.com/mohamedwaleed/shopping-assistant/issues/9) | Connect models through Vercel AI SDK provider adapters | #3 |
| 09 | [#10 CLOSED](https://github.com/mohamedwaleed/shopping-assistant/issues/10) | Enforce research and monitoring budgets | #9 |
| 10 | [#11 CLOSED](https://github.com/mohamedwaleed/shopping-assistant/issues/11) | Ingest a product page with inspectable evidence (hardening in 36) | #8 withdrawn |
| 11 | [#12 CLOSED](https://github.com/mohamedwaleed/shopping-assistant/issues/12) | Normalize attributes and review conflicting claims | #11 |
| 12 | [#13](https://github.com/mohamedwaleed/shopping-assistant/issues/13) | Search catalogue identifiers, filters and bilingual text | #12 |
| 13 | [#14](https://github.com/mohamedwaleed/shopping-assistant/issues/14) | Discover external candidates using SearXNG | #13 |
| 14 | [#15](https://github.com/mohamedwaleed/shopping-assistant/issues/15) | Configure Tavily Search and Extract independently | #10, #14 |
| 15 | [#16](https://github.com/mohamedwaleed/shopping-assistant/issues/16) | Make extraction resilient and expose source coverage | #10, #12 |
| 16 | [#17 CLOSED](https://github.com/mohamedwaleed/shopping-assistant/issues/17) | Stream persistent bilingual chat with Vercel AI SDK | #10 |
| 17 | [#18](https://github.com/mohamedwaleed/shopping-assistant/issues/18) | Run the controlled Vercel AI SDK shopping agent loop | #13, #17 |
| 18 | [#19](https://github.com/mohamedwaleed/shopping-assistant/issues/19) | Checkpoint and recover the SDK agent loop in durable workers | #18 |
| 19 | [#20](https://github.com/mohamedwaleed/shopping-assistant/issues/20) | Extend the same agent loop with external discovery and ingestion | #14, #16, #19 |
| 20 | [#21](https://github.com/mohamedwaleed/shopping-assistant/issues/21) | Save preferences and invalidate revised research | #18 |
| 21 | [#22](https://github.com/mohamedwaleed/shopping-assistant/issues/22) | Compare exact variants in persisted interactive tables | #18 |
| 22 | [#23](https://github.com/mohamedwaleed/shopping-assistant/issues/23) | Watch an exact offer and receive target alerts | #16, #19 |
| 23 | [#24](https://github.com/mohamedwaleed/shopping-assistant/issues/24) | Watch variants across sellers and meaningful price drops | #14, #23 |
| 24 | [#25](https://github.com/mohamedwaleed/shopping-assistant/issues/25) | Deliver email alerts with schedules and quiet hours | #5, #23 |
| 25 | [#26](https://github.com/mohamedwaleed/shopping-assistant/issues/26) | Expose shopping operations through personal HTTP tokens | #4, #20, #22, #24 |
| 26 | [#27](https://github.com/mohamedwaleed/shopping-assistant/issues/27) | Connect external assistants through authenticated MCP | #26 |
| 27 | [#28](https://github.com/mohamedwaleed/shopping-assistant/issues/28) | Disable and restore users without resuming private work | #6, #25, #27 |
| 28 | [#29](https://github.com/mohamedwaleed/shopping-assistant/issues/29) | Delete private data and enforce retention | #21, #28 |
| 29 | [#30](https://github.com/mohamedwaleed/shopping-assistant/issues/30) | Import evidence from an approved structured source | #12, #19 |
| 30 | [#31](https://github.com/mohamedwaleed/shopping-assistant/issues/31) | Add optional multilingual semantic catalogue retrieval | #10, #13 |
| 31 | [#32](https://github.com/mohamedwaleed/shopping-assistant/issues/32) | Connect eligible ChatGPT plan usage to shopping chat | #17 |
| 32 | [#33](https://github.com/mohamedwaleed/shopping-assistant/issues/33) | Expose truthful Claude-plan availability in settings | #9 |
| 33 | [#34](https://github.com/mohamedwaleed/shopping-assistant/issues/34) | Operate and restore the full self-hosted stack | #29 |
| 35 | [#43](https://github.com/mohamedwaleed/shopping-assistant/issues/43) | Build the invite, recovery and email-change screens | None |
| 36 | [#44](https://github.com/mohamedwaleed/shopping-assistant/issues/44) | Harden product-page ingestion | None |
| 34 | [#35](https://github.com/mohamedwaleed/shopping-assistant/issues/35) | Verify complete flows and measured release coverage | #7, #15, #30, #31, #32, #33, #34 |

Verified 34 open issues, ready-for-agent labels, mirrored acceptance criteria and 57 native GitHub blocking relationships. Parent issue body, title, state, labels, assignees and milestone are unchanged.
