import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { useChatStore } from '@/store/chat-store'
import { ReviewResultsPanel } from './ReviewResultsPanel'
import type { ReviewResponse } from '@/types/projects'

let isMobile = false

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

describe('ReviewResultsPanel', () => {
  beforeEach(() => {
    isMobile = false
    useChatStore.setState({
      reviewResults: {},
      fixedReviewFindings: {},
      reviewSidebarVisible: false,
    })
  })

  it('shows review metadata and failure scenario for structured findings', () => {
    const reviewResults: ReviewResponse = {
      summary: 'One high-confidence correctness issue found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          category: 'correctness',
          confidence: 'high',
          blocking: true,
          introduced_by_diff: true,
          file: 'src/App.tsx',
          line: 42,
          title: 'Null access after guard removal',
          description:
            'The new code dereferences value after removing a guard.',
          failure_scenario: 'When value is null, rendering throws.',
          suggestion: 'Restore the null guard before dereferencing value.',
        },
      ],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    render(<ReviewResultsPanel sessionId="session-1" />)

    expect(screen.getByText('Correctness')).toBeInTheDocument()
    expect(screen.getByText('High confidence')).toBeInTheDocument()
    expect(screen.getByText('Blocking')).toBeInTheDocument()
    expect(screen.getByText('Introduced by diff')).toBeInTheDocument()
    expect(screen.getByText('Failure Scenario')).toBeInTheDocument()
    expect(
      screen.getByText('When value is null, rendering throws.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/praise/i)).not.toBeInTheDocument()
  })

  it('shows a running indicator while the review is in progress', () => {
    render(<ReviewResultsPanel sessionId="session-1" isReviewing />)

    expect(screen.getByText('Review running...')).toBeInTheDocument()
    expect(screen.queryByText('No review results')).not.toBeInTheDocument()
  })

  it('does not show a close button for code review results', () => {
    const reviewResults: ReviewResponse = {
      summary: 'No findings.',
      approval_status: 'approved',
      findings: [],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    render(<ReviewResultsPanel sessionId="session-1" />)

    expect(
      screen.queryByRole('button', { name: 'Close' })
    ).not.toBeInTheDocument()
  })

  it('uses a vertical master-detail layout on mobile', () => {
    isMobile = true
    const reviewResults: ReviewResponse = {
      summary: 'One issue found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          file: 'src/components/chat/hooks/useGitOperations.ts',
          title: 'Review completion event can be missed',
          description: 'The frontend can miss a fast completion event.',
        },
      ],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    const { container } = render(<ReviewResultsPanel sessionId="session-1" />)

    expect(
      container.querySelector('[data-panel-group-direction="vertical"]')
    ).toBeInTheDocument()
  })

  it('scrolls the finding details back to the top when selecting another finding', async () => {
    const reviewResults: ReviewResponse = {
      summary: 'Two issues found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          file: 'src/App.tsx',
          title: 'First finding',
          description: 'First finding details.',
        },
        {
          severity: 'warning',
          file: 'src/App.tsx',
          title: 'Second finding',
          description: 'Second finding details.',
        },
      ],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    const { container } = render(<ReviewResultsPanel sessionId="session-1" />)
    const detailScrollViewport = container.querySelectorAll(
      '[data-slot="scroll-area-viewport"]'
    )[1]
    expect(detailScrollViewport).toBeInstanceOf(HTMLElement)
    const detailScrollElement = detailScrollViewport as HTMLElement

    detailScrollElement.scrollTop = 240

    await userEvent.click(
      screen.getByRole('button', { name: /second finding/i })
    )

    expect(detailScrollElement.scrollTop).toBe(0)
  })
})
