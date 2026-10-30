import NotFoundView from "@/components/NotFoundView";
import LinkDataRescue from "@/components/fan/LinkDataRescue";

// A fan link that doesn't open (paused, blocked, switched off or unknown): the
// same branded 404, plus the fan's "Download / Delete my data" controls.
export default function SpinLinkNotFound() {
  return (
    <NotFoundView>
      <LinkDataRescue />
    </NotFoundView>
  );
}
