import { z } from "zod";

export const platformSchema = z.enum(["telegram", "max", "whatsapp"]);

export const integrationInput = z.object({
  platform: platformSchema,
  name: z.string().trim().min(2).max(80),
  credentials: z.record(z.string(), z.string()).default({}),
});

export const destinationInput = z.object({
  integrationId: z.string().uuid(),
  externalId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(120),
  kind: z.enum(["group", "channel", "dialog"]).default("group"),
});

export const destinationIdsInput = z.array(z.string().uuid()).min(1).refine((items) => new Set(items).size === items.length, "Получатели не должны повторяться");

export const postDestinationsInput = z.object({
  destinationIds: destinationIdsInput,
});

export const postInput = z
  .object({
    text: z.string().trim().max(4000).default(""),
    mode: z.enum(["now", "scheduled", "recurring"]),
    scheduledAt: z.string().datetime().optional(),
    cronPattern: z.string().trim().refine((value) => value.split(/\s+/).length === 5, "Cron должен содержать 5 полей").optional(),
    timezone: z.literal("Europe/Moscow").default("Europe/Moscow"),
    destinationIds: destinationIdsInput,
    attachmentIds: z.array(z.string().uuid()).max(10).default([]).refine((items) => new Set(items).size === items.length, "Файлы не должны повторяться"),
    intervalSeconds: z.coerce.number().int().min(1).max(86400).default(30),
    maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
    retryDelaySeconds: z.coerce.number().int().min(1).max(3600).default(30),
  })
  .superRefine((value, context) => {
    if (!value.text && value.attachmentIds.length === 0) {
      context.addIssue({ code: "custom", path: ["text"], message: "Добавьте текст или хотя бы один файл" });
    }
    if (value.mode === "scheduled" && !value.scheduledAt) {
      context.addIssue({ code: "custom", path: ["scheduledAt"], message: "Укажите дату отправки" });
    }
    if (value.mode === "recurring" && !value.cronPattern) {
      context.addIssue({ code: "custom", path: ["cronPattern"], message: "Укажите cron-расписание" });
    }
  });
