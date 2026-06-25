/**
 * Creates "The Gratitude Gala 2024 Auction Donation Form" in Google Forms.
 *
 * How to use:
 * 1) Go to script.google.com and create a new project.
 * 2) Paste this file into Code.gs.
 * 3) Run createAuctionDonationForm() once and authorize permissions.
 * 4) Open View > Logs (or Executions) for the edit and published URLs.
 */
function createAuctionDonationForm() {
  var form = FormApp.create('The Gratitude Gala 2024 Auction Donation Form');

  form.setDescription(
    'Please complete and return by September 30, 2024.\n\n' +
    'Please also include a company logo (.jpg for social media and a vector file for banners), ' +
    'photos or images of the donated item, and collateral/advertising materials as appropriate, ' +
    'to Debi Alexander at Debi@sparcsolutions.org.\n\n' +
    'Benefits of donating include recognition in the program, our annual report, website, ' +
    'social media and visibility to our event attendees and online visitors.'
  );

  form.addTextItem()
    .setTitle('Donor Name (as it should appear in all listings)')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Point of Contact')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Email')
    .setHelpText('Please provide the best email for follow-up.')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Telephone')
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Address')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Item Name')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Estimated Value (USD)')
    .setHelpText('Enter a number (example: 250).')
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Item Description')
    .setRequired(true);

  // Choices must be created from the checkbox item itself, not from the form.
  var deliveryItem = form.addCheckboxItem();
  deliveryItem
    .setTitle('Please check all that apply:')
    .setChoices([
      deliveryItem.createChoice('Physical item/certificate accompanies this form.'),
      deliveryItem.createChoice('Physical item/certificate will be delivered/mailed by September 30, 2024, to SPARC.'),
      deliveryItem.createChoice('Please pick up the item/certificate (call 571-407-1807 or email Debi@sparcsolutions.org).'),
      deliveryItem.createChoice('Please create a certificate.')
    ])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Additional Notes')
    .setHelpText('Optional: include delivery instructions or restrictions.');

  form.setConfirmationMessage(
    'Thank you for your donation submission. We appreciate your support of The Gratitude Gala.'
  );

  Logger.log('Edit URL: %s', form.getEditUrl());
  Logger.log('Published URL: %s', form.getPublishedUrl());
}
