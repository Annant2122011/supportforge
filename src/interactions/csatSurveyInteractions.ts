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
  submitCsatSurveyComment,
  submitCsatSurveyRating,
} from '../services/csatSurveyService';

type CsatSurveyInteraction = ButtonInteraction | ModalSubmitInteraction;

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'The feedback operation could not be completed. Please try again later.';
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
      try {
        const submission = await submitCsatSurveyRating(surveyId, interaction.user.id, rating);
        await interaction.editReply({
          content: submission.alreadySubmitted
            ? '✅ Your feedback for this ticket was already recorded. You cannot submit another rating. The optional comment control remains available for a short time.'
            : '✅ Thank you. Your rating of **' + submission.rating + '/5** was saved privately. You can optionally add one comment within 15 minutes.',
          components: buildCsatSurveyComponents(surveyId, true),
        });
      } catch (error) {
        await interaction.followUp({ content: safeError(error) }).catch(() => undefined);
      }
      return true;
    }

    const commentMatch = /^qf:csat:comment:([0-9a-f-]{36})$/i.exec(id);
    if (commentMatch) {
      const surveyId = commentMatch[1]!;
      try {
        if (!(await canAddCsatSurveyComment(surveyId, interaction.user.id))) {
          await interaction.reply({
            content: 'The optional comment is unavailable. Submit a rating first; comments can be added once within 15 minutes.',
          });
          return true;
        }
        const modal = new ModalBuilder()
          .setCustomId('qf:csat:modal:' + surveyId)
          .setTitle('Optional feedback comment')
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('comment')
                .setLabel('What could we improve?')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Your comment is private and limited to 500 characters.')
                .setRequired(true)
                .setMaxLength(500),
            ),
          );
        await interaction.showModal(modal);
      } catch (error) {
        await interaction.reply({ content: safeError(error) }).catch(() => undefined);
      }
      return true;
    }

    await interaction.reply({ content: 'This feedback control is invalid or has expired.' }).catch(() => undefined);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('qf:csat:modal:')) {
    const surveyId = interaction.customId.slice('qf:csat:modal:'.length);
    if (!/^[0-9a-f-]{36}$/i.test(surveyId)) {
      await interaction.reply({ content: 'This feedback form is invalid or has expired.' });
      return true;
    }
    await interaction.deferReply();
    try {
      await submitCsatSurveyComment(
        surveyId,
        interaction.user.id,
        interaction.fields.getTextInputValue('comment'),
      );
      await interaction.editReply('✅ Your optional comment was saved privately. Thank you for helping improve support.');
    } catch (error) {
      await interaction.editReply(safeError(error));
    }
    return true;
  }

  return false;
}
