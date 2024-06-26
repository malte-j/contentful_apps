import { AppActionCallContext } from '@contentful/node-apps-toolkit';
import {
  AppActionCallResponse,
  EntryActivityMessage,
  SendEntryActivityMessageResult,
  SendWorkflowUpdateMessageResult,
  Topic,
  WorkflowUpdateMessage,
} from '../types';
import { EntryProps } from 'contentful-management/types';
import helpers from '../helpers';
import { parametersFromAppInstallation } from '../helpers/app-installation';
import { config } from '../config';
import { withAsyncAppActionErrorHandling } from '../helpers/error-handling';
import { TOPIC_ACTION_MAP } from '../constants';

// Todo: expand this to describe Workflows payload
interface AppActionCallParameters {
  payload: string;
  topic: string;
  eventDatetime: string;
}

export const handler = withAsyncAppActionErrorHandling(
  async (
    parameters: AppActionCallParameters,
    context: AppActionCallContext
  ): Promise<
    AppActionCallResponse<SendEntryActivityMessageResult[] | SendWorkflowUpdateMessageResult>
  > => {
    const {
      cma,
      appActionCallContext: { appInstallationId, environmentId, spaceId, userId, cmaHost },
    } = context;

    const { payload, topic: topicString, eventDatetime } = parameters;

    /**
     * In the interest of time, as well as prototyping/learning we made the explicit choice
     * to re-use/extend this "app-events" app-action to handle "workflow" events as well.
     *
     * This block of code to handle workflow topics is intentionally repetative and intrusive.
     * The end goal is to create a new app action to specifically handle "workflow" events.
     * Ideally, at that time, it will be a simple copy/paste operation, leaving this
     * app-action unchanged.
     */
    if (topicString === TOPIC_ACTION_MAP['Workflow.Step.notifyMicrosoftTeams']) {
      const appInstallation = await cma.appInstallation.get({ appDefinitionId: appInstallationId });
      const { tenantId } = parametersFromAppInstallation(appInstallation);

      // request body
      const entry = JSON.parse(payload) as EntryProps;

      const entryActivity = await helpers.buildEntryActivity(
        { entry, topic: topicString, eventDatetime },
        cma,
        cmaHost
      );

      const title = entryActivity.entryTitle;
      const contentTypeId = entry.sys.contentType.sys.id;

      const workflowUpdateMessage: WorkflowUpdateMessage = {
        title: title,
        contentType: contentTypeId,
        currentStep: 'currentStep', // hard-coded - to be replaced with correct step once payload from workflow-consumer-api is determined.
        previousStep: 'previousStep', // hard-coded - to be replaced with correct step once payload from workflow-consumer-api is determined.
        callToActionUrl: entryActivity.entryUrl,
        updateDateTime: entryActivity.eventDatetime,
      };

      const sendWorkflowUpdateResult = await config.msTeamsBotService.sendWorkflowUpdateMessage(
        workflowUpdateMessage,
        tenantId,
        { appInstallationId, environmentId, userId, spaceId }
      );

      return {
        ok: true,
        data: { sendWorkflowUpdateResult, workflowUpdateMessage },
      };
    }
    /** END workflows block */

    // TODO parse entry and topic
    const entry = JSON.parse(payload) as EntryProps;
    const contentTypeId = entry.sys.contentType.sys.id;
    const topic = topicString as Topic;

    const entryActivity = await helpers.buildEntryActivity(
      { entry, topic, eventDatetime },
      cma,
      cmaHost
    );

    const appInstallation = await cma.appInstallation.get({ appDefinitionId: appInstallationId });
    const { tenantId, notifications } = parametersFromAppInstallation(appInstallation);

    const matchingNotifications = notifications.filter((notification) => {
      // don't send if tenant id doesn't match
      if (notification.channel.tenantId !== tenantId) return false;

      // don't send if the notification is for a different content type
      if (notification.contentTypeId !== contentTypeId) return false;

      // don't send if the topic is not "checked" in the notification subscription
      if (
        topic !== TOPIC_ACTION_MAP['Workflow.Step.notifyMicrosoftTeams'] &&
        !notification.selectedEvents[topic]
      )
        return false;

      return true;
    });

    const entryActivityMessages = matchingNotifications.map(async (notification) => {
      const entryActivityMessage: EntryActivityMessage = {
        channel: {
          teamId: notification.channel.teamId,
          channelId: notification.channel.id,
        },
        entryActivity,
      };

      const sendMessageResult = await config.msTeamsBotService.sendEntryActivityMessage(
        entryActivityMessage,
        tenantId,
        { appInstallationId, environmentId, userId, spaceId }
      );

      return { sendMessageResult, entryActivityMessage };
    });

    const sendEntryActiviyMessageResult: SendEntryActivityMessageResult[] = await Promise.all(
      entryActivityMessages
    );

    return {
      ok: true,
      data: sendEntryActiviyMessageResult,
    };
  }
);
