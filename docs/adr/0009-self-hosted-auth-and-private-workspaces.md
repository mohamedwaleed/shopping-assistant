# Keep identity self-hosted and private workspace ownership separate

Use Better Auth with PostgreSQL inside the application rather than requiring a hosted identity service, while keeping shopping authorization in the core. Each initial user owns one private workspace; installation invitations create access without sharing another shopper’s information. This retains control for self-hosters and future hosted isolation, accepting responsibility for operating identity and recovery; installation administration does not include routine private-conversation or credential browsing.
