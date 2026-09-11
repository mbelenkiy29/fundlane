import { z } from "zod"

export const TEAM_SIZES = ["1", "2–5", "6–15", "16–50", "51+"] as const
export const demoSchema = z
  .object({
    requestId: z.string().uuid("Refresh the page and try again."),
    name: z
      .string()
      .trim()
      .min(1, "Enter your name.")
      .max(100, "Use 100 characters or fewer."),
    email: z
      .string()
      .trim()
      .email("Enter a valid work email.")
      .max(254)
      .transform((value) => value.toLowerCase()),
    brokerage: z
      .string()
      .trim()
      .min(1, "Enter your brokerage name.")
      .max(150, "Use 150 characters or fewer."),
    teamSize: z.enum(TEAM_SIZES, { error: "Choose your team size." }),
    message: z
      .string()
      .trim()
      .max(2000, "Use 2,000 characters or fewer.")
      .default(""),
    website: z.string().max(0, "Unable to accept this request.").default(""),
  })
  .strict()

export type DemoRequest = z.infer<typeof demoSchema>
