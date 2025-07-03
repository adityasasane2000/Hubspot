const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// Middleware
app.use(express.json());
require('dotenv').config();


// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Root route
app.get('/', (req, res) => {
    res.json({ 
        message: 'HubSpot Automation Server is Running!',
        timestamp: new Date().toISOString()
    });
});

// Test route to check environment variables
app.get('/test', (req, res) => {
    res.json({
        message: 'Environment Test',
        hasHubSpotToken: !!process.env.HUBSPOT_ACCESS_TOKEN,
        hasGeminiKey: !!process.env.GEMINI_API_KEY,
        hasWebhookSecret: !!process.env.WEBHOOK_SECRET,
        timestamp: new Date().toISOString()
    });
});

// Simple activity log endpoint
let activityLog = [];
app.get('/activity-log', (req, res) => {
    res.json({
        message: 'Recent Activity Log',
        activities: activityLog.slice(-10), // Show last 10 activities
        timestamp: new Date().toISOString()
    });
});

// Function to log activity
function logActivity(message, data = {}) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        message: message,
        data: data
    };
    activityLog.push(logEntry);
    console.log('ACTIVITY:', logEntry);
    
    // Keep only last 50 entries
    if (activityLog.length > 50) {
        activityLog = activityLog.slice(-50);
    }
}

// HubSpot webhook endpoint for deals
app.post('/webhook/deal-created', async (req, res) => {
    // Log the full request for debugging
    console.log('Received /webhook/deal-created POST:', {
        headers: req.headers,
        body: req.body
    });

    try {
        logActivity('Deal webhook received', { bodyLength: req.body?.length || 0 });
        console.log('Deal webhook received:', req.body);
        
        // Verify webhook (basic check)
        if (!req.body || !Array.isArray(req.body) || !req.body.length) {
            logActivity('Invalid webhook data received');
            return res.status(400).json({ error: 'Invalid webhook data' });
        }

        // Process each subscription event
        for (const event of req.body) {
            if (event.subscriptionType === 'deal.creation') {
                logActivity('Processing deal creation', { dealId: event.objectId });
                await processDealCreation(event);
            }
        }

        logActivity('Deal webhook processed successfully');
        res.status(200).json({ message: 'Deal webhook processed successfully' });
    } catch (error) {
        logActivity('Deal webhook error', { error: error.message });
        console.error('Deal webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// HubSpot webhook endpoint for customer replies (conversations)
app.post('/webhook/email-reply', async (req, res) => {
    try {
        console.log('Conversation webhook received:', req.body);

        // Verify webhook (basic check)
        if (!req.body || !Array.isArray(req.body) || !req.body.length) {
            return res.status(400).json({ error: 'Invalid webhook data' });
        }

        // Process each subscription event
        for (const event of req.body) {
            // Listen for conversation "created" events
            if (event.object === 'conversation' && event.eventId === 'created') {
                await processConversationReply(event);
            }
        }

        res.status(200).json({ message: 'Conversation webhook processed successfully' });
    } catch (error) {
        console.error('Conversation webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Process conversation reply (new message in a conversation)
async function processConversationReply(event) {
    try {
        const conversationId = event.objectId;
        console.log('📥 Processing conversation ID:', conversationId);

        // Get conversation details (including latest message)
        const conversationData = await getConversationData(conversationId);
        // You may need to adjust the API endpoint and parsing based on HubSpot's API docs

        // Example: Get the latest message and its direction
        const messages = conversationData.threads?.[0]?.messages || [];
        const latestMessage = messages[messages.length - 1];
        if (!latestMessage) {
            console.log('No messages found in conversation.');
            return;
        }

        const direction = latestMessage.direction || latestMessage.senderType; // Adjust as per API
        const content = latestMessage.text || latestMessage.body || '';
        const subject = conversationData.subject || 'No Subject';

        // Only process incoming messages (from customer)
        if (direction === 'INCOMING' || direction === 'VISITOR') {
            console.log('✅ Incoming conversation message detected');

            // Get associations (deals, contacts, etc.)
            const associations = await getConversationAssociations(conversationId);

            // Find all associated deals
            const dealIds = associations.results
                .filter(assoc => assoc.type === 'conversation_to_deal')
                .map(assoc => assoc.id);

            if (dealIds.length === 0) {
                console.log('No associated deals found for this conversation.');
                return;
            }

            // For each associated deal, generate AI response and save note
            for (const dealId of dealIds) {
                const aiResponse = await generateConversationResponse(subject, content);
                console.log('🧠 AI response generated for deal:', dealId);

                await saveEmailResponseNoteToDeal(conversationId, aiResponse, dealId);
                console.log('📝 AI note saved to HubSpot for deal:', dealId);
            }
        } else {
            console.log('⏩ Skipping outgoing or system message:', { direction });
        }
    } catch (error) {
        console.error('❌ Error processing conversation reply:', error.message);
        throw error;
    }
}

// Fetch conversation details from HubSpot
async function getConversationData(conversationId) {
    try {
        const response = await axios.get(
            `https://api.hubapi.com/conversations/v3/conversations/${conversationId}`,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data;
    } catch (error) {
        console.error('Error getting conversation data:', error);
        throw error;
    }
}

// Fetch conversation associations (deals, contacts, etc.)
async function getConversationAssociations(conversationId) {
    try {
        const response = await axios.get(
            `https://api.hubapi.com/conversations/v3/conversations/${conversationId}/associations`,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data;
    } catch (error) {
        console.error('Error getting conversation associations:', error);
        return { results: [] };
    }
}

// Generate AI response to conversation message
async function generateConversationResponse(subject, content) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        const prompt = `
        A customer has sent us a message. Please generate a professional, helpful response:

        Subject: ${subject}
        Message: ${content}

        Generate a response that:
        1. Acknowledges their message professionally
        2. Addresses their concerns or questions
        3. Provides helpful information
        4. Suggests next steps if appropriate
        5. Maintains a warm, professional tone

        Keep it concise, helpful, and customer-focused.
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error('Error generating conversation response:', error);
        throw error;
    }
}

// Save email response note to a specific deal in HubSpot
async function saveEmailResponseNoteToDeal(emailId, aiResponse, dealId) {
    try {
        const noteData = {
            engagement: {
                active: true,
                type: 'NOTE'
            },
            associations: {
                emailIds: [emailId],
                dealIds: [dealId]
            },
            metadata: {
                body: `AI-Generated Email Response:\n\n${aiResponse}\n\n--- \nThis is a suggested response to the customer's email. Please review before sending.`
            }
        };

        const response = await axios.post(
            'https://api.hubapi.com/engagements/v1/engagements',
            noteData,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return response.data;
    } catch (error) {
        console.error('Error saving email response note to HubSpot:', error);
        throw error;
    }
}

// Process deal creation
async function processDealCreation(event) {
    try {
        const dealId = event.objectId;
        console.log('Processing deal ID:', dealId);

        // Get email data from HubSpot
        const dealData = await getDealData(dealId);
        console.log('Deal data retrieved:', dealData);

        // Generate email content with AI
        const emailContent = await generateEmailContent(dealData);
        console.log('Email content generated');

        // Save note to HubSpot
        await saveNoteToHubSpot(dealId, emailContent);
        console.log('Note saved to HubSpot');

    } catch (error) {
        console.error('Error processing deal:', error);
        throw error;
    }
}

// Get email data from HubSpot
async function getEmailData(emailId) {
    try {
        const response = await axios.get(
            `https://api.hubapi.com/crm/v3/objects/emails/${emailId}`,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                params: {
                    properties: 'hs_email_subject,hs_email_text,hs_email_direction,hs_email_status,hs_timestamp'
                }
            }
        );
        return response.data;
    } catch (error) {
        console.error('Error getting email data:', error);
        throw error;
    }
}

// Get email associations (contacts, deals)
async function getEmailAssociations(emailId) {
    try {
        const response = await axios.get(
            `https://api.hubapi.com/crm/v3/objects/emails/${emailId}/associations`,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data;
    } catch (error) {
        console.error('Error getting email associations:', error);
        return { results: [] };
    }
}

// Generate AI response to customer email
async function generateEmailResponse(emailData, associations) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        
        const emailInfo = emailData.properties;
        const subject = emailInfo.hs_email_subject || 'No Subject';
        const content = emailInfo.hs_email_text || 'No Content';
        
        const prompt = `
        A customer has sent us an email. Please generate a professional, helpful response:
        
        Customer Email Subject: ${subject}
        Customer Email Content: ${content}
        
        Generate a response that:
        1. Acknowledges their message professionally
        2. Addresses their concerns or questions
        3. Provides helpful information
        4. Suggests next steps if appropriate
        5. Maintains a warm, professional tone
        
        Keep it concise, helpful, and customer-focused.
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error('Error generating email response:', error);
        throw error;
    }
}

// Save email response note to HubSpot
async function saveEmailResponseNote(emailId, aiResponse, associations) {
    try {
        const noteData = {
            engagement: {
                active: true,
                type: 'NOTE'
            },
            associations: {
                emailIds: [emailId],
                // Add contact and deal associations if they exist
                contactIds: associations.results
                    .filter(assoc => assoc.type === 'email_to_contact')
                    .map(assoc => assoc.id),
                dealIds: associations.results
                    .filter(assoc => assoc.type === 'email_to_deal')
                    .map(assoc => assoc.id)
            },
            metadata: {
                body: `AI-Generated Email Response:\n\n${aiResponse}\n\n--- \nThis is a suggested response to the customer's email. Please review before sending.`
            }
        };

        const response = await axios.post(
            'https://api.hubapi.com/engagements/v1/engagements',
            noteData,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return response.data;
    } catch (error) {
        console.error('Error saving email response note to HubSpot:', error);
        throw error;
    }
}

// Get deal data from HubSpot
async function getDealData(dealId) {
    try {
        const response = await axios.get(
            `https://api.hubapi.com/crm/v3/objects/deals/${dealId}`,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                params: {
                    properties: 'dealname,amount,dealstage,closedate,pipeline,dealtype,description'
                }
            }
        );
        return response.data;
    } catch (error) {
        console.error('Error getting deal data:', error);
        throw error;
    }
}

// Generate email content using Gemini AI
async function generateEmailContent(dealData) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        
        const dealInfo = dealData.properties;
        const prompt = `
        Generate a professional follow-up email for a new deal with these details:
        
        Deal Name: ${dealInfo.dealname || 'N/A'}
        Amount: ${dealInfo.amount || 'N/A'}
        Stage: ${dealInfo.dealstage || 'N/A'}
        Close Date: ${dealInfo.closedate || 'N/A'}
        Description: ${dealInfo.description || 'N/A'}
        
        Create a warm, professional email that:
        1. Thanks the prospect for their interest
        2. Summarizes the deal details
        3. Suggests next steps
        4. Maintains a helpful tone
        
        Keep it concise and actionable.
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error('Error generating email content:', error);
        throw error;
    }
}

// Save note to HubSpot
async function saveNoteToHubSpot(dealId, emailContent) {
    try {
        const noteData = {
            engagement: {
                active: true,
                type: 'NOTE'
            },
            associations: {
                dealIds: [dealId]
            },
            metadata: {
                body: `AI-Generated Follow-up Email:\n\n${emailContent}`
            }
        };

        const response = await axios.post(
            'https://api.hubapi.com/engagements/v1/engagements',
            noteData,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return response.data;
    } catch (error) {
        console.error('Error saving note to HubSpot:', error);
        throw error;
    }
}

// Test endpoint for email replies
app.post('/test-email-reply', async (req, res) => {
    try {
        const mockEvent = {
            subscriptionType: 'communication.creation',
            objectId: req.body.emailId || '67890'
        };
        
        await processEmailReply(mockEvent);
        res.json({ message: 'Test email reply processed successfully' });
    } catch (error) {
        console.error('Test email error:', error);
        res.status(500).json({ error: error.message });
    }
});
app.post('/test-deal', async (req, res) => {
    try {
        const mockEvent = {
            subscriptionType: 'deal.creation',
            objectId: req.body.dealId || '12345'
        };
        
        await processDealCreation(mockEvent);
        res.json({ message: 'Test deal processed successfully' });
    } catch (error) {
        console.error('Test error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Export for Vercel
module.exports = app;

// For local development
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}