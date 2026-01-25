export const textFallbackMaker = (props) => props.completedTime
    ? `r/${props.subredditName} reached ${props.goal} subscribers!\n\nGoal reached at \`${props.completedTime.toISOString()}\`.`
    : `Welcome to r/${props.subredditName}\n\n${props.subscribers} / ${props.goal} subscribers.\n  Help us reach our goal!\n\nVisit this post on Shreddit to enjoy interactive features.`;
const supportsTextFallback = (post) => {
    if (!post || typeof post !== 'object') {
        return false;
    }
    return ('setTextFallback' in post &&
        typeof post.setTextFallback === 'function');
};
export const applyTextFallback = async (post, props) => {
    if (!supportsTextFallback(post)) {
        return;
    }
    await post.setTextFallback({ text: textFallbackMaker(props) });
};
//# sourceMappingURL=textFallback.js.map