/** The server remains authoritative; this only controls the lobby button. */
export function potLaunchAction(canLaunch: boolean, humanSeats: number[], paidSeats: number[]) {
  if (!canLaunch) return { label: 'WAITING FOR HOST', disabled: true }
  if (humanSeats.length < 2) return { label: 'WAITING FOR PLAYER', disabled: true }
  if (!humanSeats.every(seat => paidSeats.includes(seat))) {
    return { label: 'WAITING FOR PAYMENT', disabled: true }
  }
  return { label: 'LAUNCH', disabled: false }
}
