export const subscriberTrackingPendingByUserKey =
  "subscriber_tracking_pending_by_user_v1";
export const subscriberTrackingPendingByOperationKey =
  "subscriber_tracking_pending_by_operation_v1";
export const subscriberTrackingQueueKey = "subscriber_tracking_queue_v1";
export const subscriberTrackingUsernameToUserIdKey =
  "subscriber_tracking_username_to_user_id_v1";
const erasureGenerationPrefix = "subscriber_tracking_erasure_generation_v1";

export const subscriberTrackingGenerationKey = (userId: string): string =>
  `${erasureGenerationPrefix}:${userId}`;
