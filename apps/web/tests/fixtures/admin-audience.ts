// Synthetic .test identities only; shared by UI tests and local screenshot evidence.
export const sampleUserId = "11111111-1111-4111-8111-111111111111";
export const sampleEmailId = "22222222-2222-4222-8222-222222222222";
const account = {
  id: sampleUserId,
  email: "reader@example.test",
  name: "Example Reader",
  confirmedAt: "2026-10-24T10:00:00Z",
  createdAt: "2026-10-24T09:00:00Z",
  lastSignInAt: "2026-10-25T12:00:00Z",
  onboardingCompleted: true,
  hasProfile: true,
  subscriptionCount: 3,
};
export const usersFixture = {
  users: [
    account,
    {
      ...account,
      id: "33333333-3333-4333-8333-333333333333",
      name: "Pending Reader",
      email: "pending@example.test",
      confirmedAt: null,
      lastSignInAt: null,
      hasProfile: false,
      onboardingCompleted: false,
      subscriptionCount: 0,
    },
  ],
  page: 1,
  q: "",
  hasMore: false,
  total: 2,
};
export const userFixture = {
  user: account,
  preferences: {
    notificationEmail: "reader@example.test",
    neighborhood: "Downtown",
    digestEnabled: false,
    digestFrequency: "each_meeting",
  },
  subscriptions: [
    {
      id: 1,
      type: "matter",
      label: "Community park plan",
      createdAt: "2026-10-24T10:00:00Z",
      radius: null,
    },
    {
      id: 2,
      type: "topic",
      label: "Transportation",
      createdAt: "2026-10-24T10:00:00Z",
      radius: null,
    },
    {
      id: 3,
      type: "neighborhood",
      label: "Downtown",
      createdAt: "2026-10-24T10:00:00Z",
      radius: 1000,
    },
  ],
  subscriptionCount: 3,
  page: 1,
  hasMore: false,
};
const message = {
  id: sampleEmailId,
  userId: sampleUserId,
  recipient: "reader@example.test",
  subject: "Council meeting: community park plan",
  type: "meeting_digest",
  status: "accepted",
  attempts: 1,
  providerId: "44444444-4444-4444-8444-444444444444",
  createdAt: "2026-10-25T12:05:00Z",
  updatedAt: "2026-10-25T12:05:02Z",
  acceptedAt: "2026-10-25T12:05:02Z",
  deliveredAt: null,
  failedAt: null,
  error: "",
};
export const emailsFixture = {
  available: true,
  messages: [message],
  hasMore: false,
  total: 1,
  filters: {
    page: 1,
    status: "",
    type: "",
    user: "",
    recipient: "",
    from: "",
    to: "",
  },
};
export const emailFixture = {
  available: true,
  message: {
    ...message,
    preview:
      "Council approved the community park plan. Your saved interests include local development and transportation.",
  },
  events: [
    {
      id: sampleEmailId,
      type: "accepted",
      attempt: 1,
      providerId: message.providerId,
      occurredAt: "2026-10-25T12:05:02Z",
      error: "",
    },
    {
      id: sampleUserId,
      type: "attempt_started",
      attempt: 1,
      providerId: null,
      occurredAt: "2026-10-25T12:05:00Z",
      error: "",
    },
  ],
  hasMore: false,
  page: 1,
};
