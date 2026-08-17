import { useParams } from "react-router-dom";
import { ParticipationWorkbench } from "./ParticipationPage";

/**
 * Everyone the schools entered, read-only.
 *
 * Owner 2026-08-17: "the students will be added by the institutes, not the
 * host, so no need of the add — we will go for view only". The people arrive
 * on the school's own team form (the participants sheet at the top of it), so
 * a host-side add box offered a second, competing way to create the same
 * person — which is exactly the duplicate-identity problem this layer exists
 * to remove. Withdrawing went with it: a person is removed by the school
 * editing its own submission.
 *
 * The route stays so existing links keep working; the surface is the same
 * workbench the Team registration page embeds, so there is one list, not two.
 */
export function ParticipantsPage(): React.ReactElement {
  const { id = "" } = useParams();
  return <ParticipationWorkbench tournamentId={id} />;
}
