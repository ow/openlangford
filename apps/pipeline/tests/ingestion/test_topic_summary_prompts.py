"""The summary writer's prompts live in shared/prompts/topic-summaries.json, read by the pipeline and the site."""
from pipeline.ingestion import matter_summaries as ms
from pipeline.ingestion.record_sources import CHECK_RULE, RECORD_RULE


def test_shared_prompts_carry_the_record_rules():
    # The file holds the composed text: a change to a rule in record_sources.py must be copied into it.
    assert RECORD_RULE in ms.SYSTEM
    assert CHECK_RULE in ms.CHECK_PROMPT


def test_system_prompt_lists_every_topic_and_status():
    assert ", ".join(ms.TOPICS) in ms.SYSTEM
    assert ", ".join(ms.STATUSES) in ms.SYSTEM
