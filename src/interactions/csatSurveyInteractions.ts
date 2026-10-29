import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';

import {
  buildCsatSurveyComponents,
  canAddCsatSurveyComment,
  getCsatSurveyLocale,
  submitCsatSurveyComment,
  submitCsatSurveyRating,
} from '../services/csatSurveyService';
import { translate } from '../i18n/translationService';

type CsatSurveyInteraction = ButtonInteraction | ModalSubmitInteraction;

function safeError(error: unknown, locale: unknown = 'en-US'): string {
  const message = error instanceof Error ? error.message : '';
  const safeMessages = new Set([
    'This feedback survey was not found or is no longer available.',
    'Only the ticket creator can submit this feedback.',
    'This ticket is no longer closed. The feedback survey has been cancelled.',
    'This feedback survey has expired.',
    'This survey is not currently accepting a response.',
    'Rating must be a whole number from 1 to 5.',
    'Feedback comment must be text.',
    'Feedback comments must be 500 characters or fewer.',
    'Enter a comment or cancel the optional comment form.',
    'The optional comment window has expired or a comment was already saved.',
  ]);
  return safeMessages.has(message) ? message : translate(locale, 'csat.survey.error.generic');
}

/** Handles private CSAT DM components before general ticket interaction routing. */
export async function handleCsatSurveyInteraction(interaction: CsatSurveyInteraction): Promise<boolean> {
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (!id.startsWith('qf:csat:')) return false;

    const ratingMatch = /^qf:csat:rate:([0-9a-f-]{36}):([1-5])$/i.exec(id);
    if (ratingMatch) {
      const surveyId = ratingMatch[1]!;
      const rating = Number(ratingMatch[2]);
      await interaction.deferUpdate();
      let locale: string = 'en-US';
      try {
        locale = await getCsatSurveyLocale(surveyId);
        const submission = await submitCsatSurveyRating(surveyId, interaction.user.id, rating);
        await interaction.editReply({
          content: '✅ ' + (submission.alreadySubmitted
            ? translate(locale, 'csat.survey.rating.duplicate')
            : translate(locale, 'csat.survey.rating.saved', { rating: submission.rating })),
          components: buildCsatSurveyComponents(surveyId, locale, true),
        });
      } catch (error) {
        await interaction.followUp({ content: safeError(error, locale) }).catch(() => undefined);
      }
      return true;
    }

    const commentMatch = /^qf:csat:comment:([0-9a-f-]{36})$/i.exec(id);
    if (commentMatch) {
      const surveyId = commentMatch[1]!;
      let locale: string = 'en-US';
      try {
        locale = await getCsatSurveyLocale(surveyId);
        if (!(await canAddCsatSurveyComment(surveyId, interaction.user.id))) {
          await interaction.reply({
            content: translate(locale, 'csat.survey.comment.unavailable'),
          });
          return true;
        }
        const modal = new ModalBuilder()
          .setCustomId('qf:csat:modal:' + surveyId)
          .setTitle(translate(locale, 'csat.survey.comment.modal.title'))
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('comment')
                .setLabel(translate(locale, 'csat.survey.comment.modal.label'))
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder(translate(locale, 'csat.survey.comment.modal.placeholder'))
                .setRequired(true)
                .setMaxLength(500),
            ),
          );
        await interaction.showModal(modal);
      } catch (error) {
        await interaction.reply({ content: safeError(error, locale) }).catch(() => undefined);
      }
      return true;
    }

    await interaction.reply({ content: 'This feedback control is invalid or has expired.' }).catch(() => undefined);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('qf:csat:modal:')) {
    const surveyId = interaction.customId.slice('qf:csat:modal:'.length);
    if (!/^[0-9a-f-]{36}$/i.test(surveyId)) {
      await interaction.reply({ content: translate('en-US', 'csat.survey.form.invalid') });
      return true;
    }
    await interaction.deferReply();
    let locale: string = 'en-US';
    try {
      locale = await getCsatSurveyLocale(surveyId);
      await submitCsatSurveyComment(
        surveyId,
        interaction.user.id,
        interaction.fields.getTextInputValue('comment'),
      );
      await interaction.editReply('✅ ' + translate(locale, 'csat.survey.comment.saved'));
    } catch (error) {
      await interaction.editReply(safeError(error, locale));
    }
    return true;
  }

  return false;
}
