import dotenv from "dotenv";
import Replicate from "replicate";
import { StreamingTextResponse } from "ai";
import { currentUser } from "@clerk/nextjs";
import { NextResponse } from "next/server";

import { MemoryManager } from "@/lib/memory";
import { rateLimit } from "@/lib/rate-limit";
import prismadb from "@/lib/prismadb";

dotenv.config({ path: `.env` });

// Creating Replicate client instance
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

export async function POST(
  request: Request,
  { params }: { params: { chatId: string } }
) {
  try {
    const { prompt } = await request.json();
    const user = await currentUser();

    // Checking if user is authenticated
    if (!user || !user.firstName || !user.id) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    // Rate limiting logic
    const identifier = request.url + "-" + user.id;
    const { success } = await rateLimit(identifier);

    if (!success) {
      return new NextResponse("Rate limit exceeded", { status: 429 });
    }

    // Update companion
    const companion = await prismadb.companion.update({
      where: {
        id: params.chatId
      },
      data: {
        messages: {
          create: {
            content: prompt,
            role: "user",
            userId: user.id,
          },
        },
      }
    });

    // Construct prompt for Replicate model
    const promptForModel = `
      ONLY generate plain sentences without prefix of who is speaking. DO NOT use ${companion.name}: prefix. 

      ${companion.instructions}

      Below are relevant details about ${companion.name}'s past and the conversation you are in.
      
      ${prompt}\n${companion.name}:
    `;

    // Run meta/llama-2-13b-chat using Replicate's API
    const output = await replicate.run(
      "meta/llama-2-13b-chat",
      {
        input: {
          debug: false,
          top_k: 50,
          top_p: 1,
          prompt: promptForModel,
          temperature: 0.75,
          system_prompt: "You are a helpful, respectful and honest assistant. Always answer as helpfully as possible, while being safe. Your answers should not include any harmful, unethical, racist, sexist, toxic, dangerous, or illegal content. Please ensure that your responses are socially unbiased and positive in nature.\n\nIf a question does not make any sense, or is not factually coherent, explain why instead of answering something not correct. If you don't know the answer to a question, please don't share false information.",
          max_new_tokens: 500,
          min_new_tokens: -1
        }
      }
    );

    // Initialize MemoryManager
    const memoryManager = await MemoryManager.getInstance();

    // Create companionKey
    const companionKey = {
      companionName: companion.id, // Assuming companion.id is the name you want to use
      userId: user.id,
      modelName: "llama2-13b", // Assuming this is the model name you want to use
    };

    // Example response from Replicate
    let response = output.toString().trim(); // Convert output to string and trim any leading or trailing whitespaces

    // Remove commas and stars from the response
    response = response.replace(/[,*]/g, '');

    // Split response into separate lines
    let responseLines = response.split("\n"); // Use a new variable 'responseLines' for the array

    // Write response to history
    await memoryManager.writeToHistory(responseLines.join("\n"), companionKey);

    // Update companion with system message
    await prismadb.companion.update({
      where: {
        id: params.chatId
      },
      data: {
        messages: {
          create: {
            content: responseLines.join("\n"), // Use 'responseLines' when you want the full response
            role: "system",
            userId: user.id,
          },
        },
      }
    });

    // Create a readable stream for the response
    var Readable = require("stream").Readable;
    let s = new Readable();
    responseLines.forEach(line => {
      s.push(line + "\n");
    });
    s.push(null);

    // Return the response as a streaming text response
    return new StreamingTextResponse(s);

  } catch (error) {
    console.error(error);
    return new NextResponse("Internal Error", { status: 500 });
  }
};
