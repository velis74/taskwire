---
title: 'Task progress for FastAPI, Celery and Vue'
description: 'taskwire reports progress, asks the user awaitable questions and handles cancellation for long-running backend jobs, in Python and TypeScript.'
layout: home
hero:
  name: taskwire
  text: Talk to a job while it runs
  image:
    src: /taskwire-icon.svg
    alt: taskwire
  tagline: Progress, awaitable dialogs, cancellation and collectable results — in Python and TypeScript.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: API reference
      link: /api/python
features:
  - title: Progress that composes
    details: Nested subtasks whose percentages add up instead of overwriting each other, and commits coalesced so a tight loop cannot flood anything.
  - title: Questions, not guesses
    details: A worker can stop mid-job, ask the user something, and block until somebody answers. First answer wins across every tab that is looking.
  - title: Cancellation that works
    details: Cooperative and sticky, and it raises at the next progress call — so a loop with no cancellation code in it still stops.
  - title: The store is the truth
    details: Every change is written before anything is pushed, so a dropped push costs latency and never correctness. That is what makes the transport swappable.
---
