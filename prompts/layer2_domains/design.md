<!--
  What this file does:
    Domain module for design roles (product design, UX research, design systems,
    visual design, interaction design).
    Applied when roleFamily="design".

  What to change here if intent changes:
    - To add new design tools or accessibility standards: edit section B and C.
    - To update quantitative UX metrics: edit section C.
    - To adjust action verbs: edit section D.

  Depends on:
    - services/classifier.js (sets domainModuleKey="design")
    - services/promptAssembler.js (loads this file by key)
    - layer1_global_rules.md
-->

## DOMAIN MODULE: DESIGN

### A. DOMAIN CONTEXT

Designers create interfaces, systems, and experiences that help users accomplish goals. Success is measured by task completion rate, user satisfaction, conversion uplift, and the quality of handoff to engineering. The vocabulary is research-driven and systems-oriented: user research, usability testing, design systems, component libraries, accessibility (WCAG), interaction design, prototyping, and design critiques.

### B. CANONICAL TOOL REGISTRY

- **Consumer tech (Airbnb, Uber, Lyft, Meta, Google):** Figma, Sketch, Principle, Framer, InVision, Zeplin, Google Material Design, user research repos (Dovetail, EnjoyHQ), Maze, Hotjar
- **Enterprise SaaS (Salesforce, ServiceNow, Workday):** Figma, Salesforce Lightning Design System, Storybook, component library governance, accessibility testing
- **E-commerce (Shopify, Wayfair):** Figma, Polaris design system (Shopify), A/B testing, heatmaps (Hotjar, FullStory), Optimizely
- **Agencies and consultancies (IDEO, frog, Accenture Song):** Service design tools, Miro, FigJam, stakeholder co-design workshops, design sprint facilitation

### C. TIER 1 KEYWORD CLASSES

- Design tools (Figma, Sketch, Adobe XD, etc.)
- Research methods (usability testing, interviews, card sorting, tree testing)
- Design systems and component libraries
- Prototyping tools and fidelity levels
- Accessibility standards (WCAG 2.1/2.2, ARIA)
- Collaboration and handoff tools
- Quantitative UX metrics (task completion, SUS, CSAT, NPS)
- Design process vocabulary (ideation, wireframing, user flows, information architecture)

### D. ACTION VERB POOL

Designed, Prototyped, Researched, Tested, Iterated, Facilitated, Developed (design system), Mapped (user journeys), Reduced (friction/error rate), Improved (completion rate/satisfaction), Documented, Collaborated, Presented, Advocated (accessibility), Shipped, Validated, Synthesised, Defined, Established (design tokens/standards), Conducted (user interviews)

### E. SUMMARY FRAMING GUIDANCE

Open with role title, years, and design function (product design/UX research/design systems/visual design). Name the primary tool and design system context. Close with user or business outcome language matching the JD.
