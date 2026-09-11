"use client"
import { useState } from "react"
import { MessageCircleQuestion } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { QuestionView } from "@/lib/mca/assistant/experience-contracts"
export function QuestionCard({
  question,
  busy,
  onAnswer
}: {
  question: QuestionView
  busy: boolean
  onAnswer: (answers: Record<string, string>) => void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onAnswer(answers)
      }}
      className="space-y-4 rounded-xl border border-primary/30 bg-primary/5 p-4"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <MessageCircleQuestion className="size-4 text-primary" />A little more
        detail
      </div>
      {question.questions.map((q) => (
        <fieldset key={q.id} disabled={busy} className="space-y-2">
          <legend className="mb-2 text-sm font-medium">{q.question}</legend>
          {!!q.options.length && (
            <div className="flex flex-wrap gap-2">
              {q.options.map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={answers[q.id] === option ? "secondary" : "outline"}
                  aria-pressed={answers[q.id] === option}
                  className="h-auto max-w-full whitespace-normal py-2 text-left"
                  onClick={() => setAnswers((v) => ({ ...v, [q.id]: option }))}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}
          <Textarea
            aria-label={`Your answer: ${q.question}`}
            placeholder="Or write your answer…"
            value={answers[q.id] ?? ""}
            maxLength={4000}
            rows={2}
            onChange={(e) =>
              setAnswers((v) => ({ ...v, [q.id]: e.target.value }))
            }
          />
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Your reply continues this request. No extra credit.
        </p>
        <Button
          type="submit"
          size="sm"
          disabled={
            busy || question.questions.some((q) => !answers[q.id]?.trim())
          }
        >
          Continue
        </Button>
      </div>
    </form>
  )
}
