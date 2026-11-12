---
title: 'Progress, dialogs and cancellation for long jobs'
description: 'Nested progress, awaitable dialogs where the first answer wins across tabs, sticky cancellation and collectable results for long-running jobs. Python and TypeScript.'
layout: home
hero:
  name: taskwire
  text: Progress and dialogs for long-running jobs
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
  - title: Nested progress
    details: Nested subtasks whose percentages add up instead of overwriting each other, and commits coalesced to one per interval.
  - title: Awaitable dialogs
    details: A worker asks the user a question mid-job and blocks until it is answered. The first answer wins across every open tab.
  - title: Sticky cooperative cancellation
    details: Cancellation raises at the next progress call, so a loop with no cancellation code of its own stops.
  - title: The store holds the state
    details: Every change is written before anything is pushed; a dropped push delays an update and never changes it. Transports are interchangeable.
---
