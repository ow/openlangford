import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { AgendaOverview } from "../../app/components/meeting/AgendaOverview";
import type { AgendaItem } from "../../app/lib/types";

const stage = "Council will consider first, second, and third readings of changes to meeting schedules, livestreaming, and recording rules.";
const effects = "The proposed amendments clarify the annual meeting schedule, remove a fixed start time from the procedure bylaw, and specify when open portions of meetings will not be livestreamed or recorded.";
const item: AgendaItem = {
  id: 1,
  meeting_id: 2,
  matter_id: null,
  item_order: "10.1",
  title: "Council Procedure Bylaw 1971, Amendment No. 4, Bylaw No. 2304 (FIRST, SECOND AND THIRD READINGS)",
  plain_english_summary: stage,
  description: effects,
  is_controversial: false,
  is_consent_agenda: false,
  created_at: "2026-11-24",
};

function render(expanded: boolean, override: Partial<AgendaItem> = {}, isPlanned = true) {
  return renderToStaticMarkup(
    h(
      MemoryRouter,
      null,
      h(AgendaOverview, {
        items: [{ ...item, ...override }],
        isPlanned,
        expandedItemId: expanded ? item.id : null,
        onItemClick: vi.fn(),
        onWatchVideo: vi.fn(),
        meetingId: item.meeting_id,
      }),
    ),
  );
}

it.each([false, true])("uses proposal detail once instead of a generic reading summary (expanded=%s)", (expanded) => {
  const html = render(expanded);
  expect(html).toContain(effects);
  // The collapsed row has a preview, plus the CSS-hidden disclosure body.
  const button = html.split("</button>", 1)[0];
  expect(button.includes(effects)).toBe(!expanded);
  if (expanded) expect(html.split(effects)).toHaveLength(2);
  else expect(html).toContain('inert=""');
  expect(html).not.toContain("Scheduled:");
  expect(html).not.toContain(stage);
});

it.each([
  "Council will consider first reading of changes to when meetings start, allowing earlier starts for busy agendas.",
  "Council will consider first reading of changes to meeting rules, making public comments optional.",
])("keeps a substantive summary that starts with the reading stage (%s)", (summary) => {
  expect(render(true, { plain_english_summary: summary })).toContain(summary);
  expect(render(true, { plain_english_summary: summary })).not.toContain(effects);
});

it("preserves the reading stage separately if it is not already in the item's title", () => {
  const html = render(true, { title: "Council Procedure Bylaw, Amendment No. 4" });
  expect(html).toContain(effects);
  expect(html).toContain("Scheduled: first, second, and third readings.");
  expect(html).not.toContain(stage);
});

it.each([
  undefined,
  "  ",
  stage,
  "Changes to meeting schedules, livestreaming, and recording rules.",
  "The agenda packet does not specify what these proposed amendments would change.",
])(
  "keeps the reading summary if the stored description adds no detail (%s)",
  (description) => {
    expect(render(true, { description })).toContain(stage);
  },
);

it("still shows a description when there is no plain-English summary", () => {
  expect(render(true, { plain_english_summary: undefined })).toContain(effects);
});

it("does not replace a summary when the meeting is not Planned", () => {
  const html = render(true, {}, false);
  expect(html).toContain(stage);
  expect(html).not.toContain(effects);
});
