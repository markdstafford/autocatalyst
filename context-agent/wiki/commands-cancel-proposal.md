# Cancel concept proposal (#154)

Propose this replacement for the Cancel bullet in [commands.md](../../context-human/concepts/commands.md) at human doc review. The concept is unchanged until approved.

> **Cancel (`cancel`).** End an unfinished run and request that the provider stop its active
> session where supported. The service returns once the run is `canceled`, without waiting
> for provider shutdown. Started sessions remain in history. When cancel commits first,
> the service discards the dispatch result without applying its effects.
