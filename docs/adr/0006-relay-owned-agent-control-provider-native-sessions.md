# ADR 0006: Relay-owned agent control with provider-native sessions

**Status:** Accepted  
**Date:** 2026-07-23

Relay owns durable run and agent identity, the agent tree, task scheduling, governance, workspace ownership, canonical events, and recovery. Stateful providers own their native session history and turn behavior behind one scoped `ProviderSessionAdapter` per Relay agent; raw providers run through Relay's provider-neutral execution-step runtime. Provider-native children must be represented in Relay's agent control plane or disabled, and provider-native approvals must be translated into Relay governance.

This hybrid boundary preserves the capabilities of deep providers such as Codex without creating a second execution authority or forcing them through a weaker raw-completion loop. It also keeps raw providers viable through one canonical Relay step runtime. The cost is capability negotiation and explicit normalization between provider-native lifecycle state and Relay's canonical model.

Tasks and agents remain distinct: a task is durable work with dependencies and an outcome, while an agent is a durable execution identity that may perform multiple tasks. Agent identity survives provider-runtime eviction and lazy restoration.
