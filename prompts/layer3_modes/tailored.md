<!--
  What this file does:
    TAILORED mode overlay — appended after Layer 1 and Layer 2 for TAILORED generation calls.
    Contains only rules specific to TAILORED mode that Layer 1 does not already cover.

  What to change here if intent changes:
    If TAILORED behaviour needs to diverge from CUSTOM_SAMPLER, edit here.
    Do NOT add global rules here — those belong in layer1_global_rules.md.
    Do NOT add domain-specific rules here — those belong in layer2_domains/.

  Depends on:
    - layer1_global_rules.md (must be consistent with it — this is an overlay, not a replacement)
    - services/promptAssembler.js (loads this file for mode="TAILORED")
-->

## TAILORED MODE RULES

### Candidate Experience Grounding

Generate bullets ONLY from the candidate's real experience as described in the RUNTIME INPUTS. Do not fabricate responsibilities, reassign tools across employers, or invent company contexts. Every bullet must be plausible given what the named company actually does and what the candidate's listed work history indicates.

### Real Employer Context

The companies in the work history are the candidate's actual employers. Apply the company authenticity rule from Layer 1 to verify that every tool and practice assigned to an employer is authentic to that company's real operating environment. The domain module tool registry is the authoritative reference.

### Location

Include the candidate's real location in the header. Include actual employer locations from the base resume in experience entries.

### AI/LLM Keywords

AI-related terms (LLM, RAG, fine-tuning, embeddings, prompt engineering, etc.) may only appear in the most recent experience slot. If the candidate's most recent company does not authentically use these tools in its operating environment, move AI terms to the Technical Skills section rather than forcing them into bullets.
