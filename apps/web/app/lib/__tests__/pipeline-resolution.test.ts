import { describe, expect, it } from "vitest";
import {
  jobTarget,
  resolveFailedJob,
  type ResolutionJob,
} from "../pipeline-resolution";

const job = (over: Partial<ResolutionJob>): ResolutionJob => ({
  id: 1,
  job_type: "ingest_meeting",
  status: "failed",
  args: { source_meeting_id: 5 },
  requested_at: "2026-10-01T05:00:00Z",
  finished_at: "2026-10-01T06:00:00Z",
  ...over,
});

const doneMeeting = {
  status: "ingested",
  ingested_meeting_id: 9,
  updated_at: "2026-10-10T00:00:00Z",
};

describe("jobTarget", () => {
  it("reads source_meeting_id, then meeting_id, else null", () => {
    expect(jobTarget({ args: { source_meeting_id: 5 } })).toBe("source:5");
    expect(jobTarget({ args: { meeting_id: 5 } })).toBe("meeting:5");
    expect(jobTarget({ args: { tables: ["x"] } })).toBeNull();
    expect(jobTarget({ args: null })).toBeNull();
  });
});

describe("resolveFailedJob", () => {
  it("is unresolved with no later success and no meeting", () => {
    expect(resolveFailedJob(job({}), [])).toEqual({ resolved: false });
  });

  it("(a) resolves on a later success of the same type and target", () => {
    const later = job({ id: 2, status: "succeeded", requested_at: "2026-10-02T00:00:00Z" });
    expect(resolveFailedJob(job({}), [later])).toEqual({ resolved: true, reason: "later_success" });
  });

  it("(a) ignores earlier, other-type, other-target and non-succeeded jobs", () => {
    const candidates = [
      job({ id: 2, status: "succeeded", requested_at: "2026-09-01T00:00:00Z" }),
      job({ id: 3, status: "succeeded", job_type: "sync_media", requested_at: "2026-10-02T00:00:00Z" }),
      job({ id: 4, status: "succeeded", args: { source_meeting_id: 6 }, requested_at: "2026-10-02T00:00:00Z" }),
      job({ id: 5, status: "failed", requested_at: "2026-10-02T00:00:00Z" }),
    ];
    expect(resolveFailedJob(job({}), candidates)).toEqual({ resolved: false });
  });

  it("(a) matches targetless jobs only against targetless jobs", () => {
    const failed = job({ args: { tables: ["x"] }, job_type: "discover_meetings" });
    const same = job({ id: 2, status: "succeeded", args: { limit: 1 }, job_type: "discover_meetings", requested_at: "2026-10-02T00:00:00Z" });
    const targeted = job({ id: 3, status: "succeeded", args: { source_meeting_id: 1 }, job_type: "discover_meetings", requested_at: "2026-10-02T00:00:00Z" });
    expect(resolveFailedJob(failed, [same]).resolved).toBe(true);
    expect(resolveFailedJob(failed, [targeted]).resolved).toBe(false);
  });

  it("(b) resolves when the meeting is done and updated after the failure", () => {
    expect(resolveFailedJob(job({}), [], doneMeeting)).toEqual({ resolved: true, reason: "meeting_done" });
  });

  it("(b) stays unresolved if the failure is newer than the meeting's last update", () => {
    const stale = { ...doneMeeting, updated_at: "2026-09-01T00:00:00Z" };
    expect(resolveFailedJob(job({}), [], stale).resolved).toBe(false);
  });

  it("(b) needs an ingested meeting", () => {
    expect(resolveFailedJob(job({}), [], { ...doneMeeting, ingested_meeting_id: null }).resolved).toBe(false);
    expect(resolveFailedJob(job({}), [], { ...doneMeeting, status: "documents_downloaded" }).resolved).toBe(false);
  });

  it("(c) resolves for cancelled or postponed meetings", () => {
    expect(resolveFailedJob(job({}), [], { status: "cancelled" })).toEqual({ resolved: true, reason: "meeting_not_held" });
  });

  it("never resolves non-failed jobs", () => {
    expect(resolveFailedJob(job({ status: "succeeded" }), [], doneMeeting).resolved).toBe(false);
  });
});
