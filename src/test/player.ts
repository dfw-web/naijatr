import { act, screen } from '@testing-library/react'

/**
 * screen.findByTitle, then a moment for React to run the player's effects (its
 * message listeners) before the test posts player events. Under load the
 * iframe can be found before those effects have run, and an event posted then
 * would be missed.
 */
export async function findPlayer(...args: Parameters<typeof screen.findByTitle>) {
  const element = await screen.findByTitle(...args)
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  return element
}
