import { z } from "zod";

export const platformSchema = z.enum(["telegram", "max", "whatsapp", "vk"]);

export const integrationInput = z.object({
  platform: platformSchema,
  name: z.string().trim().min(2).max(80),
  credentials: z.record(z.string(), z.string()).default({}),
});

export const destinationInput = z.object({
  integrationId: z.string().uuid(),
  externalId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(2).max(120),
  kind: z.enum(["group", "channel", "dialog"]).default("group"),
});

export const postInput = z
  .object({
    text: z.string().trim().min(1).max(4000),
    mediaUrl: z.union([z.string().url(), z.literal("")]).optional(),
    mode: z.enum(["now", "scheduled", "recurring"]),
    scheduledAt: z.string().datetime().optional(),
    cronPattern: z.string().trim().optional(),
    timezone: z.string().trim().default("Europe/Moscow"),
    destinationIds: z.array(z.string().uuid()).min(1),
  })
  .superRefine((value, context) => {
    if (value.mode === "scheduled" && !value.scheduledAt) {
      context.addIssue({ code: "custom", path: ["scheduledAt"], message: "Укажите дату отправки" });
    }
    if (value.mode === "recurring" && !value.cronPattern) {
      context.addIssue({ code: "custom", path: ["cronPattern"], message: "Укажите cron-расписание" });
    }
  });
