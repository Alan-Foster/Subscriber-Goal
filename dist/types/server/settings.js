export const defaultAppSettings = {
    promoSubreddit: 'SubGoal',
};
export async function getAppSettings(settings) {
    if (!settings) {
        return defaultAppSettings;
    }
    const allSettings = await settings.getAll();
    return {
        promoSubreddit: typeof allSettings.promoSubreddit === 'string'
            ? allSettings.promoSubreddit
            : defaultAppSettings.promoSubreddit,
    };
}
//# sourceMappingURL=settings.js.map