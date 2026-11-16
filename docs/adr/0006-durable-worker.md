# Execute durable background work in a separate worker

The application runs web/API and worker processes separately, sharing PostgreSQL and distributed together with Docker Compose. Persistent research and monitoring work survives restarts and can resume independently of chat requests, accepting additional process coordination to support daily watches and recovery from downtime. The precise durable-job implementation remains undecided.
